import { createHash, randomUUID } from 'node:crypto';
import { Psbt, Transaction } from 'bitcoinjs-lib';
import { env } from '../config/env.js';
import { bitcoinCoreClient, type BitcoinCoreClient } from '../connectors/bitcoinCoreClient.js';
import {
  bitcoinAddressScript,
  bitcoinJsNetwork,
  formatMsatAsBtc,
  msatToSats,
  parseBitcoinDestination,
  parseBtcDecimalToMsat,
  psbtUnsignedFingerprint,
  satsToMsat,
  supportedFundingInputType
} from '../connectors/bitcoinProtocol.js';
import type { BitcoinNetwork, BtcpayScopeType } from '../domain/bitcoin.js';
import { asAssetId } from '../domain/payment.js';
import { ApiError } from '../lib/errors.js';
import { asAtomicAmount } from '../lib/money.js';
import { AppModel } from '../models/app.model.js';
import { BitcoinPsbtModel, type BitcoinPsbtRecord } from '../models/bitcoin.model.js';
import { SessionModel } from '../models/session.model.js';
import { writeAuditLog } from './audit.service.js';

const BTC_ASSET_ID = asAssetId('bitcoin:btc');
const DUST_SATS = 546n;
const MAX_INPUTS = 50;
const RBF_SEQUENCE = 0xfffffffd;
const BROADCAST_RECOVERY_DELAY_MS = 5_000;

export interface BitcoinOutpointInput {
  txid: string;
  vout: number;
}

export interface CreateBitcoinPsbtInput {
  ownerWalletId: string;
  scopeType: BtcpayScopeType;
  scopeId?: string;
  idempotencyKey: string;
  network: BitcoinNetwork;
  destination: string;
  amountAtomic: string;
  inputs: BitcoinOutpointInput[];
  changeAddress: string;
  feeRateSatVb: string;
  maxFeeAtomic: string;
  minInputConfirmations: number;
  requiredConfirmations: number;
  replacesPsbtId?: string;
}

interface ResolvedInput {
  txid: string;
  vout: number;
  valueAtomic: string;
  scriptHex: string;
  inputType: 'p2wpkh' | 'p2tr';
  confirmations: number;
}

export interface BitcoinPsbtDto {
  id: string;
  status: string;
  connectorId: 'bitcoin-core-psbt';
  scope: { type: BtcpayScopeType; id: string };
  network: BitcoinNetwork;
  assetId: 'bitcoin:btc';
  atomicUnit: 'millisatoshi';
  recipient: { address: string; amountAtomic: string };
  fee: { amountAtomic: string; maxAmountAtomic: string; rateSatVb: string };
  change?: { address: string; amountAtomic: string };
  inputs: Array<{ txid: string; vout: number; valueAtomic: string; confirmations: number }>;
  psbt?: string;
  txid?: string;
  confirmations: number;
  requiredConfirmations: number;
  replaceable: boolean;
  replacesPsbtId?: string;
  replacedByPsbtId?: string;
  failure?: { code: string; message?: string };
  createdAt: string;
  broadcastAt?: string;
  confirmedAt?: string;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function expectedCoreChain(network: BitcoinNetwork): string {
  if (network === 'mainnet') return 'main';
  if (network === 'testnet') return 'test';
  return network;
}

async function assertCoreNetwork(core: BitcoinCoreClient, network: BitcoinNetwork): Promise<void> {
  if (network !== env.BITCOIN_NETWORK) {
    throw new ApiError(400, 'BITCOIN_CORE_NETWORK_MISMATCH', 'Requested Bitcoin network does not match the configured Core node.');
  }
  const info = await core.getBlockchainInfo();
  if (info.chain !== expectedCoreChain(network)) {
    throw new ApiError(503, 'BITCOIN_CORE_NETWORK_MISMATCH', 'Bitcoin Core reports a different network.');
  }
  if (info.initialblockdownload) {
    throw new ApiError(503, 'BITCOIN_CORE_NOT_READY', 'Bitcoin Core is still synchronizing.');
  }
}

async function assertScopeOwnership(ownerWalletId: string, scopeType: BtcpayScopeType, requestedScopeId?: string): Promise<string> {
  if (scopeType === 'wallet') return ownerWalletId;
  const scopeId = requestedScopeId?.trim();
  if (!scopeId) throw new ApiError(400, 'BITCOIN_PSBT_SCOPE_ID_REQUIRED', 'Pass and app PSBT requests require a scope id.');
  const owned = scopeType === 'pass'
    ? await SessionModel.exists({ publicId: scopeId, ownerWalletId })
    : await AppModel.exists({ appId: scopeId, ownerWalletId, status: 'active' });
  if (!owned) throw new ApiError(404, 'BITCOIN_PSBT_SCOPE_NOT_FOUND', 'Bitcoin PSBT scope was not found for this wallet.');
  return scopeId;
}

function normalizedOutpoints(inputs: BitcoinOutpointInput[]): BitcoinOutpointInput[] {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_INPUTS) {
    throw new ApiError(400, 'BITCOIN_INPUTS_INVALID', 'Bitcoin PSBT requires between one and 50 funding inputs.');
  }
  const normalized = inputs.map((input) => ({ txid: input.txid.trim().toLowerCase(), vout: input.vout }));
  if (normalized.some((input) => !/^[0-9a-f]{64}$/.test(input.txid) || !Number.isSafeInteger(input.vout) || input.vout < 0)) {
    throw new ApiError(400, 'BITCOIN_OUTPOINT_INVALID', 'Bitcoin funding outpoint is invalid.');
  }
  if (new Set(normalized.map((input) => input.txid + ':' + input.vout)).size !== normalized.length) {
    throw new ApiError(400, 'BITCOIN_OUTPOINT_DUPLICATE', 'Bitcoin PSBT contains duplicate funding inputs.');
  }
  return normalized;
}

function coreValueToAtomic(value: number | string): string {
  const decimal = typeof value === 'number' ? value.toFixed(8) : value;
  return parseBtcDecimalToMsat(decimal, { onchain: true, field: 'Bitcoin Core UTXO value' });
}

function outputVbytes(scriptHex: string): bigint {
  const bytes = BigInt(scriptHex.length / 2);
  return 8n + (bytes < 253n ? 1n : 3n) + bytes;
}

function estimateVbytes(inputs: ResolvedInput[], outputScripts: string[]): bigint {
  const inputSize = inputs.reduce((total, input) => total + (input.inputType === 'p2tr' ? 58n : 68n), 0n);
  return 11n + inputSize + outputScripts.reduce((total, script) => total + outputVbytes(script), 0n);
}

function reverseTxid(hash: Uint8Array): string {
  return Buffer.from(hash).reverse().toString('hex');
}

function toDto(record: BitcoinPsbtRecord & { createdAt?: Date }, psbt?: string): BitcoinPsbtDto {
  return {
    id: record.psbtId,
    status: record.status,
    connectorId: 'bitcoin-core-psbt',
    scope: { type: record.scopeType, id: record.scopeId },
    network: record.network,
    assetId: 'bitcoin:btc',
    atomicUnit: 'millisatoshi',
    recipient: { address: record.recipientAddress, amountAtomic: record.amountAtomic },
    fee: { amountAtomic: record.feeAtomic, maxAmountAtomic: record.maxFeeAtomic, rateSatVb: record.feeRateSatVb },
    change: record.changeAddress && record.changeAtomic ? { address: record.changeAddress, amountAtomic: record.changeAtomic } : undefined,
    inputs: record.inputs.map((input) => ({
      txid: input.txid,
      vout: input.vout,
      valueAtomic: input.valueAtomic,
      confirmations: input.confirmations
    })),
    psbt,
    txid: record.txid ?? undefined,
    confirmations: record.confirmations,
    requiredConfirmations: record.requiredConfirmations,
    replaceable: record.replaceable,
    replacesPsbtId: record.replacesPsbtId ?? undefined,
    replacedByPsbtId: record.replacedByPsbtId ?? undefined,
    failure: record.failureCode ? { code: record.failureCode, message: record.failureMessage ?? undefined } : undefined,
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    broadcastAt: record.broadcastAt?.toISOString(),
    confirmedAt: record.confirmedAt?.toISOString()
  };
}

async function resolveInputs(core: BitcoinCoreClient, outpoints: BitcoinOutpointInput[], minConfirmations: number): Promise<ResolvedInput[]> {
  return Promise.all(outpoints.map(async (outpoint) => {
    const txout = await core.getTxOut(outpoint.txid, outpoint.vout);
    if (!txout) throw new ApiError(409, 'BITCOIN_INPUT_SPENT_OR_MISSING', 'Bitcoin funding input is spent, missing, or already reserved by the mempool.');
    if (!Number.isSafeInteger(txout.confirmations) || txout.confirmations < minConfirmations) {
      throw new ApiError(409, 'BITCOIN_INPUT_CONFIRMATIONS_REQUIRED', 'Bitcoin funding input does not meet the confirmation policy.');
    }
    if (txout.coinbase && txout.confirmations < 100) {
      throw new ApiError(409, 'BITCOIN_COINBASE_IMMATURE', 'Bitcoin coinbase input is not mature.');
    }
    const scriptHex = txout.scriptPubKey?.hex?.toLowerCase() ?? '';
    return {
      txid: outpoint.txid,
      vout: outpoint.vout,
      valueAtomic: coreValueToAtomic(txout.value),
      scriptHex,
      inputType: supportedFundingInputType(scriptHex),
      confirmations: txout.confirmations
    };
  }));
}

function requestFingerprint(input: CreateBitcoinPsbtInput, recipientAddress: string, changeAddress: string, outpoints: BitcoinOutpointInput[]): string {
  return fingerprint({
    ownerWalletId: input.ownerWalletId,
    scopeType: input.scopeType,
    scopeId: input.scopeId?.trim(),
    idempotencyKey: input.idempotencyKey,
    network: input.network,
    recipientAddress,
    amountAtomic: asAtomicAmount(input.amountAtomic),
    inputs: outpoints,
    changeAddress,
    feeRateSatVb: asAtomicAmount(input.feeRateSatVb),
    maxFeeAtomic: asAtomicAmount(input.maxFeeAtomic),
    minInputConfirmations: input.minInputConfirmations,
    requiredConfirmations: input.requiredConfirmations,
    replacesPsbtId: input.replacesPsbtId?.trim()
  });
}

function coreMaxFeeRate(feeSats: bigint, virtualSize: number): string {
  const satsPerKvB = (feeSats * 1000n + BigInt(virtualSize) - 1n) / BigInt(virtualSize) + 1n;
  return formatMsatAsBtc(satsToMsat(satsPerKvB));
}

export async function createBitcoinPsbt(
  input: CreateBitcoinPsbtInput,
  core: BitcoinCoreClient = bitcoinCoreClient
): Promise<BitcoinPsbtDto> {
  const scopeId = await assertScopeOwnership(input.ownerWalletId, input.scopeType, input.scopeId);
  const amountAtomic = asAtomicAmount(input.amountAtomic);
  const amountSats = msatToSats(amountAtomic, 'Bitcoin recipient amount');
  if (amountSats < DUST_SATS) throw new ApiError(400, 'BITCOIN_RECIPIENT_DUST', 'Bitcoin recipient amount is below the conservative dust policy.');
  const destination = parseBitcoinDestination({ destination: input.destination, network: input.network, expectedAmountAtomic: amountAtomic });
  const changeAddress = input.changeAddress.trim();
  const changeScriptHex = Buffer.from(bitcoinAddressScript(changeAddress, input.network)).toString('hex');
  if (changeScriptHex === destination.scriptHex) throw new ApiError(400, 'BITCOIN_CHANGE_RECIPIENT_CONFLICT', 'Bitcoin change address must differ from the recipient.');
  const feeRateSatVb = BigInt(asAtomicAmount(input.feeRateSatVb));
  if (feeRateSatVb < 1n || feeRateSatVb > 10_000n) throw new ApiError(400, 'BITCOIN_FEE_RATE_INVALID', 'Bitcoin fee rate must be between 1 and 10000 sat/vB.');
  const maxFeeAtomic = asAtomicAmount(input.maxFeeAtomic);
  const maxFeeSats = msatToSats(maxFeeAtomic, 'Bitcoin maximum fee');
  if (maxFeeSats <= 0n) throw new ApiError(400, 'BITCOIN_FEE_LIMIT_INVALID', 'Bitcoin maximum fee must be positive.');
  if (!Number.isSafeInteger(input.minInputConfirmations) || input.minInputConfirmations < 0 || input.minInputConfirmations > 100) {
    throw new ApiError(400, 'BITCOIN_CONFIRMATION_POLICY_INVALID', 'Input confirmation policy is invalid.');
  }
  if (!Number.isSafeInteger(input.requiredConfirmations) || input.requiredConfirmations < 1 || input.requiredConfirmations > 100) {
    throw new ApiError(400, 'BITCOIN_CONFIRMATION_POLICY_INVALID', 'Required confirmation policy is invalid.');
  }

  let previous: BitcoinPsbtRecord | null = null;
  let outpoints: BitcoinOutpointInput[];
  if (input.replacesPsbtId) {
    const prior = await BitcoinPsbtModel.findOne({ psbtId: input.replacesPsbtId, ownerWalletId: input.ownerWalletId })
      .lean<BitcoinPsbtRecord | null>();
    outpoints = prior
      ? prior.inputs.map((item) => ({ txid: item.txid, vout: item.vout }))
      : input.inputs.length > 0 ? normalizedOutpoints(input.inputs) : [];
  } else {
    outpoints = normalizedOutpoints(input.inputs);
  }
  const userFingerprint = requestFingerprint({ ...input, scopeId }, destination.address, changeAddress, outpoints);
  const existing = await BitcoinPsbtModel.findOne({ ownerWalletId: input.ownerWalletId, idempotencyKey: input.idempotencyKey })
    .select('+unsignedPsbt')
    .lean<BitcoinPsbtRecord | null>();
  if (existing) {
    if (existing.requestFingerprint !== userFingerprint) throw new ApiError(409, 'BITCOIN_PSBT_IDEMPOTENCY_CONFLICT', 'Bitcoin PSBT idempotency key was used for another request.');
    return toDto(existing, existing.status === 'awaiting_signature' ? existing.unsignedPsbt : undefined);
  }
  await assertCoreNetwork(core, input.network);
  let resolvedInputs: ResolvedInput[];
  if (input.replacesPsbtId) {
    previous = await BitcoinPsbtModel.findOne({
      psbtId: input.replacesPsbtId,
      ownerWalletId: input.ownerWalletId,
      status: { $in: ['broadcast', 'confirming'] },
      replaceable: true
    }).lean<BitcoinPsbtRecord | null>();
    if (!previous) throw new ApiError(404, 'BITCOIN_REPLACEMENT_NOT_AVAILABLE', 'Replaceable Bitcoin transaction was not found.');
    if (
      previous.network !== input.network
      || previous.recipientAddress !== destination.address
      || BigInt(previous.amountAtomic) !== BigInt(amountAtomic)
      || previous.changeAddress !== changeAddress
      || feeRateSatVb <= BigInt(previous.feeRateSatVb)
    ) {
      throw new ApiError(409, 'BITCOIN_REPLACEMENT_POLICY_MISMATCH', 'Replacement must preserve recipient, amount, network, inputs, and change while increasing the fee rate.');
    }
    outpoints = previous.inputs.map((item) => ({ txid: item.txid, vout: item.vout }));
    if (input.inputs.length > 0) {
      const requested = normalizedOutpoints(input.inputs);
      if (JSON.stringify(requested) !== JSON.stringify(outpoints)) throw new ApiError(409, 'BITCOIN_REPLACEMENT_INPUT_MISMATCH', 'Replacement inputs must match the original transaction.');
    }
    resolvedInputs = previous.inputs.map((item) => ({
      txid: item.txid,
      vout: item.vout,
      valueAtomic: item.valueAtomic,
      scriptHex: item.scriptHex,
      inputType: item.inputType,
      confirmations: item.confirmations
    }));
  } else {
    resolvedInputs = await resolveInputs(core, outpoints, input.minInputConfirmations);
  }
  const conflictingOutpoint = await BitcoinPsbtModel.exists({
    ...(previous ? { psbtId: { $ne: previous.psbtId } } : {}),
    status: { $in: ['awaiting_signature', 'broadcast', 'confirming'] },
    $or: outpoints.map((outpoint) => ({ inputs: { $elemMatch: { txid: outpoint.txid, vout: outpoint.vout } } }))
  });
  if (conflictingOutpoint) {
    throw new ApiError(409, 'BITCOIN_INPUT_ALREADY_IN_USE', 'A Bitcoin funding input is already assigned to an active payment.');
  }

  const inputTotalSats = resolvedInputs.reduce((total, item) => total + msatToSats(item.valueAtomic), 0n);
  if (inputTotalSats <= amountSats) throw new ApiError(409, 'BITCOIN_INPUT_VALUE_INSUFFICIENT', 'Bitcoin funding inputs cannot cover the recipient and fee.');
  const feeWithChange = estimateVbytes(resolvedInputs, [destination.scriptHex, changeScriptHex]) * feeRateSatVb;
  let feeSats = feeWithChange;
  let changeSats = inputTotalSats - amountSats - feeWithChange;
  if (changeSats < 0n) throw new ApiError(409, 'BITCOIN_INPUT_VALUE_INSUFFICIENT', 'Bitcoin funding inputs cannot cover the recipient and fee.');
  if (changeSats < DUST_SATS) {
    const minimumNoChangeFee = estimateVbytes(resolvedInputs, [destination.scriptHex]) * feeRateSatVb;
    feeSats = inputTotalSats - amountSats;
    changeSats = 0n;
    if (feeSats < minimumNoChangeFee) throw new ApiError(409, 'BITCOIN_INPUT_VALUE_INSUFFICIENT', 'Bitcoin funding inputs cannot cover the recipient and fee.');
  }
  if (feeSats > maxFeeSats) throw new ApiError(409, 'BITCOIN_FEE_LIMIT_EXCEEDED', 'Bitcoin transaction fee exceeds the reviewed maximum.');
  if (previous && feeSats <= msatToSats(previous.feeAtomic)) {
    throw new ApiError(409, 'BITCOIN_REPLACEMENT_FEE_TOO_LOW', 'Replacement transaction must pay a higher absolute fee.');
  }

  const psbt = new Psbt({ network: bitcoinJsNetwork(input.network) });
  psbt.setVersion(2);
  for (const fundingInput of resolvedInputs) {
    psbt.addInput({
      hash: fundingInput.txid,
      index: fundingInput.vout,
      sequence: RBF_SEQUENCE,
      witnessUtxo: {
        script: Buffer.from(fundingInput.scriptHex, 'hex'),
        value: msatToSats(fundingInput.valueAtomic)
      }
    });
  }
  psbt.addOutput({ script: Buffer.from(destination.scriptHex, 'hex'), value: amountSats });
  if (changeSats > 0n) psbt.addOutput({ script: Buffer.from(changeScriptHex, 'hex'), value: changeSats });
  const unsignedFingerprint = psbtUnsignedFingerprint(psbt);
  const outputPlanHash = fingerprint(psbt.txOutputs.map((output) => ({
    scriptHex: Buffer.from(output.script).toString('hex'),
    valueSats: output.value.toString(10)
  })));
  const psbtId = 'psbt_' + randomUUID();
  let record;
  try {
    record = await BitcoinPsbtModel.create({
      psbtId,
      ownerWalletId: input.ownerWalletId,
      scopeType: input.scopeType,
      scopeId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: userFingerprint,
      network: input.network,
      assetId: BTC_ASSET_ID,
      moneyContractVersion: 2,
      recipientAddress: destination.address,
      recipientScriptHex: destination.scriptHex,
      amountAtomic,
      feeAtomic: satsToMsat(feeSats),
      maxFeeAtomic,
      feeRateSatVb: feeRateSatVb.toString(10),
      changeAddress: changeSats > 0n ? changeAddress : undefined,
      changeScriptHex: changeSats > 0n ? changeScriptHex : undefined,
      changeAtomic: changeSats > 0n ? satsToMsat(changeSats) : undefined,
      inputs: resolvedInputs,
      unsignedPsbt: psbt.toBase64(),
      unsignedFingerprint,
      outputPlanHash,
      status: 'awaiting_signature',
      requiredConfirmations: input.requiredConfirmations,
      confirmations: 0,
      replaceable: true,
      replacesPsbtId: previous?.psbtId
    });
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== 11000) throw error;
    const raced = await BitcoinPsbtModel.findOne({ ownerWalletId: input.ownerWalletId, idempotencyKey: input.idempotencyKey })
      .select('+unsignedPsbt')
      .lean<BitcoinPsbtRecord | null>();
    if (!raced || raced.requestFingerprint !== userFingerprint) {
      throw new ApiError(409, 'BITCOIN_PSBT_IDEMPOTENCY_CONFLICT', 'Bitcoin PSBT idempotency key was used for another request.');
    }
    return toDto(raced, raced.status === 'awaiting_signature' ? raced.unsignedPsbt : undefined);
  }
  await writeAuditLog({
    actorWalletId: input.ownerWalletId,
    action: 'bitcoin.psbt.created',
    targetType: 'bitcoin_psbt',
    targetId: psbtId,
    metadata: {
      scopeType: input.scopeType,
      scopeId,
      network: input.network,
      recipientScriptHash: createHash('sha256').update(destination.scriptHex).digest('hex'),
      amountAtomic,
      feeAtomic: satsToMsat(feeSats),
      inputCount: resolvedInputs.length,
      replacesPsbtId: previous?.psbtId
    }
  });
  return toDto(record.toObject(), psbt.toBase64());
}

function assertSignedPsbtMatches(record: BitcoinPsbtRecord, signed: Psbt): void {
  if (psbtUnsignedFingerprint(signed) !== record.unsignedFingerprint) {
    throw new ApiError(409, 'BITCOIN_PSBT_OUTPUT_MUTATED', 'Signed PSBT changed the reviewed transaction inputs or outputs.');
  }
  if (signed.inputCount !== record.inputs.length || signed.data.inputs.length !== record.inputs.length) {
    throw new ApiError(409, 'BITCOIN_PSBT_INPUT_MUTATED', 'Signed PSBT changed the reviewed funding inputs.');
  }
  for (let index = 0; index < record.inputs.length; index += 1) {
    const expected = record.inputs[index];
    const txInput = signed.txInputs[index];
    const witness = signed.data.inputs[index]?.witnessUtxo;
    if (
      reverseTxid(txInput.hash) !== expected.txid
      || txInput.index !== expected.vout
      || txInput.sequence !== RBF_SEQUENCE
      || !witness
      || witness.value !== msatToSats(expected.valueAtomic)
      || Buffer.from(witness.script).toString('hex') !== expected.scriptHex
    ) {
      throw new ApiError(409, 'BITCOIN_PSBT_INPUT_MUTATED', 'Signed PSBT changed reviewed funding data.');
    }
  }
  const outputPlanHash = fingerprint(signed.txOutputs.map((output) => ({
    scriptHex: Buffer.from(output.script).toString('hex'),
    valueSats: output.value.toString(10)
  })));
  if (outputPlanHash !== record.outputPlanHash) {
    throw new ApiError(409, 'BITCOIN_PSBT_OUTPUT_MUTATED', 'Signed PSBT changed the reviewed recipient, amount, fee, or change.');
  }
}

function assertFinalTransactionMatches(record: BitcoinPsbtRecord, transaction: Transaction): void {
  if (transaction.version !== 2 || transaction.locktime !== 0) {
    throw new ApiError(409, 'BITCOIN_FINAL_TRANSACTION_MUTATED', 'Final transaction changed the reviewed version or locktime.');
  }
  if (transaction.ins.length !== record.inputs.length) throw new ApiError(409, 'BITCOIN_FINAL_TRANSACTION_MUTATED', 'Final transaction input count changed.');
  for (let index = 0; index < transaction.ins.length; index += 1) {
    const input = transaction.ins[index];
    const expected = record.inputs[index];
    if (reverseTxid(input.hash) !== expected.txid || input.index !== expected.vout || input.sequence !== RBF_SEQUENCE) {
      throw new ApiError(409, 'BITCOIN_FINAL_TRANSACTION_MUTATED', 'Final transaction changed a reviewed input.');
    }
  }
  const outputs = transaction.outs.map((output) => ({
    scriptHex: Buffer.from(output.script).toString('hex'),
    valueSats: output.value.toString(10)
  }));
  if (fingerprint(outputs) !== record.outputPlanHash) {
    throw new ApiError(409, 'BITCOIN_FINAL_TRANSACTION_MUTATED', 'Final transaction changed a reviewed output.');
  }
  const inputTotal = record.inputs.reduce((total, item) => total + msatToSats(item.valueAtomic), 0n);
  const outputTotal = transaction.outs.reduce((total, output) => total + output.value, 0n);
  if (inputTotal - outputTotal !== msatToSats(record.feeAtomic)) {
    throw new ApiError(409, 'BITCOIN_FINAL_TRANSACTION_FEE_MISMATCH', 'Final transaction fee changed from the reviewed fee.');
  }
}

export async function submitSignedBitcoinPsbt(input: {
  psbtId: string;
  ownerWalletId: string;
  signedPsbt: string;
}, core: BitcoinCoreClient = bitcoinCoreClient): Promise<BitcoinPsbtDto> {
  const record = await BitcoinPsbtModel.findOne({ psbtId: input.psbtId, ownerWalletId: input.ownerWalletId })
    .select('+unsignedPsbt')
    .lean<BitcoinPsbtRecord | null>();
  if (!record) throw new ApiError(404, 'BITCOIN_PSBT_NOT_FOUND', 'Bitcoin PSBT request was not found.');
  if (record.status !== 'awaiting_signature') return reconcileBitcoinPsbt({ psbtId: input.psbtId, ownerWalletId: input.ownerWalletId }, core);
  if (input.signedPsbt.length > 300_000) throw new ApiError(400, 'BITCOIN_PSBT_TOO_LARGE', 'Signed PSBT exceeds the allowed size.');
  let signed: Psbt;
  try {
    signed = Psbt.fromBase64(input.signedPsbt, { network: bitcoinJsNetwork(record.network) });
  } catch {
    throw new ApiError(400, 'BITCOIN_PSBT_INVALID', 'Signed PSBT could not be parsed.');
  }
  assertSignedPsbtMatches(record, signed);
  const finalized = await core.finalizePsbt(input.signedPsbt);
  if (!finalized.complete || !finalized.hex) {
    throw new ApiError(409, 'BITCOIN_PSBT_SIGNATURE_INCOMPLETE', 'User wallet has not completed every PSBT input signature.');
  }
  let transaction: Transaction;
  try {
    transaction = Transaction.fromHex(finalized.hex);
  } catch {
    throw new ApiError(502, 'BITCOIN_FINAL_TRANSACTION_INVALID', 'Bitcoin Core returned an invalid final transaction.');
  }
  assertFinalTransactionMatches(record, transaction);
  const txid = transaction.getId();
  const feeSats = msatToSats(record.feeAtomic);
  const maxFeeRate = coreMaxFeeRate(feeSats, transaction.virtualSize());
  const accepted = await core.testMempoolAccept(finalized.hex, maxFeeRate);
  if (accepted.length !== 1 || accepted[0].txid !== txid || !accepted[0].allowed) {
    await BitcoinPsbtModel.updateOne(
      { psbtId: record.psbtId, status: 'awaiting_signature' },
      { $set: { status: 'failed', failureCode: 'BITCOIN_MEMPOOL_REJECTED', failureMessage: 'Bitcoin Core rejected the signed transaction.' } }
    );
    throw new ApiError(409, 'BITCOIN_MEMPOOL_REJECTED', 'Bitcoin Core rejected the signed transaction.');
  }
  const now = new Date();
  const claimed = await BitcoinPsbtModel.findOneAndUpdate(
    { psbtId: record.psbtId, status: 'awaiting_signature' },
    {
      $set: { status: 'broadcast', rawTransactionHex: finalized.hex, txid, submittedAt: now, broadcastAt: now },
      $unset: { unsignedPsbt: 1, failureCode: 1, failureMessage: 1 }
    },
    { new: true }
  ).lean<BitcoinPsbtRecord | null>();
  if (!claimed) return reconcileBitcoinPsbt({ psbtId: input.psbtId, ownerWalletId: input.ownerWalletId }, core);
  try {
    const broadcastTxid = await core.sendRawTransaction(finalized.hex, maxFeeRate);
    if (broadcastTxid !== txid) throw new ApiError(502, 'BITCOIN_BROADCAST_TXID_MISMATCH', 'Bitcoin Core returned an unexpected transaction id.');
    if (record.replacesPsbtId) {
      await BitcoinPsbtModel.updateOne(
        { psbtId: record.replacesPsbtId, ownerWalletId: input.ownerWalletId, status: { $in: ['broadcast', 'confirming'] } },
        { $set: { status: 'replaced', replacedByPsbtId: record.psbtId, replacedAt: now } }
      );
    }
  } catch {
    await BitcoinPsbtModel.updateOne(
      { psbtId: record.psbtId },
      { $set: { failureCode: 'BITCOIN_BROADCAST_OUTCOME_UNKNOWN', failureMessage: 'Bitcoin broadcast outcome requires reconciliation.' } }
    );
  }
  await writeAuditLog({
    actorWalletId: input.ownerWalletId,
    action: 'bitcoin.psbt.broadcast',
    targetType: 'bitcoin_psbt',
    targetId: record.psbtId,
    metadata: { txid, network: record.network, amountAtomic: record.amountAtomic, feeAtomic: record.feeAtomic, replacesPsbtId: record.replacesPsbtId }
  });
  const updated = await BitcoinPsbtModel.findOne({ psbtId: record.psbtId }).lean<BitcoinPsbtRecord | null>();
  if (!updated) throw new ApiError(503, 'BITCOIN_PSBT_STATE_FAILED', 'Bitcoin PSBT broadcast state could not be loaded.');
  return toDto(updated);
}

export async function reconcileBitcoinPsbt(input: {
  psbtId: string;
  ownerWalletId: string;
}, core: BitcoinCoreClient = bitcoinCoreClient): Promise<BitcoinPsbtDto> {
  const record = await BitcoinPsbtModel.findOne(input).select('+rawTransactionHex').lean<BitcoinPsbtRecord | null>();
  if (!record) throw new ApiError(404, 'BITCOIN_PSBT_NOT_FOUND', 'Bitcoin PSBT request was not found.');
  if (!['broadcast', 'confirming'].includes(record.status) || !record.txid) return toDto(record);
  let confirmations = 0;
  let observed = false;
  try {
    const transaction = await core.getRawTransaction(record.txid);
    confirmations = Math.max(0, transaction.confirmations ?? 0);
    observed = transaction.txid === record.txid;
  } catch {
    try {
      await core.getMempoolEntry(record.txid);
      observed = true;
    } catch {
      observed = false;
    }
  }
  const broadcastRecoveryDue = !record.broadcastAt
    || record.broadcastAt.getTime() <= Date.now() - BROADCAST_RECOVERY_DELAY_MS;
  if (!observed && record.rawTransactionHex && broadcastRecoveryDue) {
    try {
      const transaction = Transaction.fromHex(record.rawTransactionHex);
      assertFinalTransactionMatches(record, transaction);
      const maxFeeRate = coreMaxFeeRate(msatToSats(record.feeAtomic), transaction.virtualSize());
      const broadcastTxid = await core.sendRawTransaction(record.rawTransactionHex, maxFeeRate);
      observed = broadcastTxid === record.txid;
    } catch {
      observed = false;
    }
  }
  const confirmed = confirmations >= record.requiredConfirmations;
  const now = new Date();
  const state = {
    status: confirmed ? 'confirmed' : confirmations > 0 ? 'confirming' : 'broadcast',
    confirmations,
    ...(confirmed ? { confirmedAt: now } : {}),
    ...(!observed ? {
      failureCode: 'BITCOIN_TRANSACTION_NOT_OBSERVED',
      failureMessage: 'Bitcoin transaction is not currently visible in the mempool or indexed chain.'
    } : {})
  };
  const updated = await BitcoinPsbtModel.findOneAndUpdate(
    { psbtId: record.psbtId, status: { $in: ['broadcast', 'confirming'] } },
    {
      $set: state,
      ...(observed ? { $unset: { failureCode: 1, failureMessage: 1 } } : {})
    },
    { new: true }
  ).lean<BitcoinPsbtRecord | null>();
  if (!updated) throw new ApiError(503, 'BITCOIN_PSBT_STATE_FAILED', 'Bitcoin confirmation state could not be persisted.');
  if (observed && record.replacesPsbtId) {
    await BitcoinPsbtModel.updateOne(
      { psbtId: record.replacesPsbtId, ownerWalletId: input.ownerWalletId, status: { $in: ['broadcast', 'confirming'] } },
      { $set: { status: 'replaced', replacedByPsbtId: record.psbtId, replacedAt: record.broadcastAt ?? now } }
    );
  }
  return toDto(updated);
}

export async function getBitcoinPsbt(input: {
  psbtId: string;
  ownerWalletId: string;
}, core: BitcoinCoreClient = bitcoinCoreClient): Promise<BitcoinPsbtDto> {
  const record = await BitcoinPsbtModel.findOne(input).select('+unsignedPsbt').lean<BitcoinPsbtRecord | null>();
  if (!record) throw new ApiError(404, 'BITCOIN_PSBT_NOT_FOUND', 'Bitcoin PSBT request was not found.');
  if (['broadcast', 'confirming'].includes(record.status)) return reconcileBitcoinPsbt(input, core);
  return toDto(record, record.status === 'awaiting_signature' ? record.unsignedPsbt : undefined);
}

export async function abandonBitcoinPsbt(input: { psbtId: string; ownerWalletId: string }): Promise<BitcoinPsbtDto> {
  const now = new Date();
  const record = await BitcoinPsbtModel.findOneAndUpdate(
    { psbtId: input.psbtId, ownerWalletId: input.ownerWalletId, status: 'awaiting_signature' },
    {
      $set: { status: 'abandoned', abandonedAt: now },
      $unset: { unsignedPsbt: 1 }
    },
    { new: true }
  ).lean<BitcoinPsbtRecord | null>();
  if (!record) throw new ApiError(409, 'BITCOIN_PSBT_ABANDON_NOT_ALLOWED', 'Only an unbroadcast PSBT can be abandoned.');
  await writeAuditLog({
    actorWalletId: input.ownerWalletId,
    action: 'bitcoin.psbt.abandoned',
    targetType: 'bitcoin_psbt',
    targetId: input.psbtId
  });
  return toDto(record);
}
