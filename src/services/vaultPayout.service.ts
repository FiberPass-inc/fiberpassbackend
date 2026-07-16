import { commons, config, hd, helpers, Indexer, RPC, utils, type Cell, type CellDep, type Script } from '@ckb-lumos/lumos';
import { blockchain } from '@ckb-lumos/base';
import { bytes } from '@ckb-lumos/codec';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { fromMinorUnits } from '../lib/money.js';
import { WalletModel } from '../models/wallet.model.js';
import { parseCkbAddress } from './ckbChain.service.js';
import { deriveVaultForWallet, getVaultRuntimeConfig, minimalVaultCellCapacityShannons } from './vault.service.js';

export interface VaultPayoutInput {
  ownerWalletId: string;
  sessionId: string;
  recipientAddress: string;
  amountMinor: number;
  currency: string;
}

export interface VaultPayoutResult {
  provider: 'ckb-vault' | 'ckb-exit';
  network: string;
  proofId: string;
}

export interface VaultLiquidityBridgeInput {
  ownerWalletId: string;
  sessionId: string;
  nodeFundingAddress: string;
  amountMinor: number;
  currency: string;
}

export interface VaultPayoutReadiness {
  ready: boolean;
  code?: string;
  message?: string;
}

type RpcScript = { code_hash: string; hash_type: string; args: string };
type SecpSigner = { privateKey: string; address: string; lockHash: string; lock: Script };
type RpcOutput = { capacity: string; lock: RpcScript; type?: RpcScript | null };
type RpcCell = {
  out_point: { tx_hash: string; index: string };
  output: RpcOutput;
  output_data: string;
};

const VAULT_OPERATOR_PAYOUT_WITNESS = bytes.hexify(blockchain.WitnessArgs.pack({ lock: '0x01' }));
const DEFAULT_OPERATOR_FEE_SHANNONS = 300000n;
const MAX_PAYOUT_INPUT_CELLS = 40;
const MAX_OPERATOR_FEE_CELLS = 40;
const SECP_SIGNATURE_PLACEHOLDER = '0x' + '00'.repeat(65);

function networkConfig() {
  return env.FIBER_NETWORK.toLowerCase().includes('main') ? config.MAINNET : config.TESTNET;
}

function ckbRpcUrl(): string {
  return env.CKB_TESTNET_RPC_URL;
}

function ckbIndexerUrl(): string {
  return env.CKB_TESTNET_INDEXER_URL;
}

function toHex(value: bigint | number): string {
  return '0x' + BigInt(value).toString(16);
}

function normalizeScript(script: RpcScript): Script {
  return {
    codeHash: script.code_hash,
    hashType: script.hash_type as Script['hashType'],
    args: script.args
  };
}

function scriptToRpc(script: Script): RpcScript {
  return {
    code_hash: script.codeHash,
    hash_type: script.hashType,
    args: script.args
  };
}

function parseCapacity(value: string): bigint {
  return BigInt(value);
}

async function rpcRequest<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: Date.now(), jsonrpc: '2.0', method, params })
  });

  if (!response.ok) {
    throw new ApiError(502, 'CKB_RPC_HTTP_ERROR', 'CKB RPC request failed with HTTP ' + response.status + '.');
  }

  const payload = await response.json() as { result?: T; error?: { code?: number; message?: string } };
  if (payload.error) {
    throw new ApiError(502, 'CKB_RPC_ERROR', payload.error.message || 'CKB RPC request failed.', payload.error);
  }

  return payload.result as T;
}

async function listVaultCells(lock: Script): Promise<Cell[]> {
  const searchKey = {
    script: scriptToRpc(lock),
    script_type: 'lock',
    script_search_mode: 'exact'
  };
  const result = await rpcRequest<{ objects: RpcCell[] }>(ckbIndexerUrl(), 'get_cells', [searchKey, 'asc', toHex(MAX_PAYOUT_INPUT_CELLS)]);
  return result.objects.map((cell) => ({
    cellOutput: {
      capacity: cell.output.capacity,
      lock: normalizeScript(cell.output.lock),
      type: cell.output.type ? normalizeScript(cell.output.type) : undefined
    },
    data: cell.output_data || '0x',
    outPoint: {
      txHash: cell.out_point.tx_hash,
      index: cell.out_point.index
    }
  }));
}

function minimalRecipientCapacityMinor(recipientAddress: string): number {
  const lock = parseCkbAddress(recipientAddress);
  const cell = {
    cellOutput: {
      capacity: '0x0',
      lock,
      type: undefined
    },
    data: '0x'
  } as Parameters<typeof helpers.minimalCellCapacity>[0];
  const capacity = Number(helpers.minimalCellCapacity(cell));
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new ApiError(500, 'CKB_MIN_CAPACITY_UNSAFE', 'Unable to calculate recipient CKB cell minimum capacity.');
  }
  return capacity;
}

function vaultCellDep(): CellDep {
  if (!env.FIBERPASS_VAULT_CELL_DEP_TX_HASH || !env.FIBERPASS_VAULT_CELL_DEP_INDEX) {
    throw new ApiError(503, 'VAULT_CELL_DEP_NOT_CONFIGURED', 'Direct vault payouts require the deployed vault lock cell dep tx hash and index.');
  }
  const depType = env.FIBERPASS_VAULT_CELL_DEP_TYPE === 'dep_group' ? 'depGroup' : env.FIBERPASS_VAULT_CELL_DEP_TYPE;
  return {
    outPoint: {
      txHash: env.FIBERPASS_VAULT_CELL_DEP_TX_HASH,
      index: env.FIBERPASS_VAULT_CELL_DEP_INDEX
    },
    depType
  };
}

function secpSignerFromPrivateKey(input: {
  privateKey: string;
  expectedLockHash?: string;
  missingCode: string;
  missingMessage: string;
  mismatchCode: string;
  mismatchMessage: string;
}): SecpSigner {
  const privateKey = input.privateKey.trim();
  if (!privateKey) {
    throw new ApiError(503, input.missingCode, input.missingMessage);
  }

  const secp = networkConfig().SCRIPTS.SECP256K1_BLAKE160;
  if (!secp) {
    throw new ApiError(500, 'SECP_SCRIPT_NOT_CONFIGURED', 'CKB secp256k1 script config is unavailable.');
  }

  const lock: Script = {
    codeHash: secp.CODE_HASH,
    hashType: secp.HASH_TYPE as Script['hashType'],
    args: hd.key.privateKeyToBlake160(privateKey)
  };
  const lockHash = utils.computeScriptHash(lock);
  const expectedLockHash = input.expectedLockHash?.trim();
  if (expectedLockHash && lockHash.toLowerCase() !== expectedLockHash.toLowerCase()) {
    throw new ApiError(503, input.mismatchCode, input.mismatchMessage);
  }

  return {
    privateKey,
    address: helpers.encodeToAddress(lock, { config: networkConfig() }),
    lockHash,
    lock
  };
}

function operatorSigner(): SecpSigner {
  return secpSignerFromPrivateKey({
    privateKey: env.FIBERPASS_OPERATOR_PRIVATE_KEY,
    expectedLockHash: env.FIBERPASS_OPERATOR_LOCK_HASH,
    missingCode: 'VAULT_PAYOUT_SIGNER_NOT_CONFIGURED',
    missingMessage: 'Direct vault payouts are enabled in the product flow, but the backend operator signer is not configured yet.',
    mismatchCode: 'VAULT_OPERATOR_SIGNER_MISMATCH',
    mismatchMessage: 'Configured operator private key does not match FIBERPASS_OPERATOR_LOCK_HASH.'
  });
}

function exitSettlementSigner(): SecpSigner {
  const explicitExitKey = env.FIBER_EXIT_SETTLEMENT_PRIVATE_KEY.trim();
  const privateKey = explicitExitKey || env.FIBER_NODE_CKB_PRIVATE_KEY || env.FIBERPASS_OPERATOR_PRIVATE_KEY;
  const expectedLockHash = env.FIBER_EXIT_SETTLEMENT_LOCK_HASH.trim() || (!explicitExitKey && !env.FIBER_NODE_CKB_PRIVATE_KEY.trim() ? env.FIBERPASS_OPERATOR_LOCK_HASH : '');
  return secpSignerFromPrivateKey({
    privateKey,
    expectedLockHash,
    missingCode: 'FIBER_EXIT_SETTLEMENT_SIGNER_NOT_CONFIGURED',
    missingMessage: 'Fiber exit CKB settlement requires FIBER_EXIT_SETTLEMENT_PRIVATE_KEY, FIBER_NODE_CKB_PRIVATE_KEY, or the existing operator signer for beta settlement.',
    mismatchCode: 'FIBER_EXIT_SETTLEMENT_SIGNER_MISMATCH',
    mismatchMessage: 'Configured Fiber exit settlement private key does not match FIBER_EXIT_SETTLEMENT_LOCK_HASH.'
  });
}

export function getVaultPayoutReadiness(): VaultPayoutReadiness {
  const runtime = getVaultRuntimeConfig();
  if (!runtime.configured) {
    return { ready: false, code: 'VAULT_PAYOUT_NOT_CONFIGURED', message: 'Direct vault payouts require the deployed FiberPass vault configuration.' };
  }

  try {
    operatorSigner();
    vaultCellDep();
    return { ready: true };
  } catch (error) {
    if (error instanceof ApiError) {
      return { ready: false, code: error.code, message: error.message };
    }
    const message = error instanceof Error && error.message ? error.message : 'Direct vault payout configuration is not ready.';
    return { ready: false, code: 'VAULT_PAYOUT_NOT_READY', message };
  }
}

function outPointKey(outPoint?: { txHash: string; index: string }): string | undefined {
  return outPoint ? outPoint.txHash.toLowerCase() + ':' + outPoint.index.toLowerCase() : undefined;
}

function addCellDepOnce(txSkeleton: ReturnType<typeof helpers.TransactionSkeleton>, cellDep: CellDep): ReturnType<typeof helpers.TransactionSkeleton> {
  const key = outPointKey(cellDep.outPoint) + ':' + cellDep.depType;
  const exists = txSkeleton.get('cellDeps').some((existing) => outPointKey(existing.outPoint) + ':' + existing.depType === key);
  if (exists) return txSkeleton;
  return txSkeleton.update('cellDeps', (cellDeps) => cellDeps.push(cellDep));
}

function secpCellDep(): CellDep {
  const secp = networkConfig().SCRIPTS.SECP256K1_BLAKE160;
  if (!secp) {
    throw new ApiError(500, 'SECP_SCRIPT_NOT_CONFIGURED', 'CKB secp256k1 script config is unavailable.');
  }
  return {
    outPoint: {
      txHash: secp.TX_HASH,
      index: secp.INDEX
    },
    depType: secp.DEP_TYPE
  };
}

function minimalPlainCellCapacityMinor(lock: Script): bigint {
  const cell = {
    cellOutput: {
      capacity: '0x0',
      lock,
      type: undefined
    },
    data: '0x'
  } as Parameters<typeof helpers.minimalCellCapacity>[0];
  return BigInt(helpers.minimalCellCapacity(cell));
}

async function listOperatorFeeCells(lock: Script, excludedOutPoints: Set<string>): Promise<Cell[]> {
  const searchKey = {
    script: scriptToRpc(lock),
    script_type: 'lock',
    script_search_mode: 'exact'
  };
  const result = await rpcRequest<{ objects: RpcCell[] }>(ckbIndexerUrl(), 'get_cells', [searchKey, 'asc', toHex(MAX_OPERATOR_FEE_CELLS)]);
  return result.objects
    .filter((cell) => !cell.output.type && (cell.output_data || '0x') === '0x')
    .map((cell) => ({
      cellOutput: {
        capacity: cell.output.capacity,
        lock: normalizeScript(cell.output.lock),
        type: undefined
      },
      data: '0x',
      outPoint: {
        txHash: cell.out_point.tx_hash,
        index: cell.out_point.index
      }
    }))
    .filter((cell) => {
      const key = outPointKey(cell.outPoint);
      return key ? !excludedOutPoints.has(key) : true;
    });
}

function setSecpSigningWitness(txSkeleton: ReturnType<typeof helpers.TransactionSkeleton>, lockHash: string): ReturnType<typeof helpers.TransactionSkeleton> {
  const firstIndex = txSkeleton.get('inputs').findIndex((input) => utils.computeScriptHash(input.cellOutput.lock).toLowerCase() === lockHash.toLowerCase());
  if (firstIndex < 0) return txSkeleton;
  while (firstIndex >= txSkeleton.get('witnesses').size) {
    txSkeleton = txSkeleton.update('witnesses', (witnesses) => witnesses.push('0x'));
  }
  const witness = bytes.hexify(blockchain.WitnessArgs.pack({ lock: SECP_SIGNATURE_PLACEHOLDER }));
  return txSkeleton.update('witnesses', (witnesses) => witnesses.set(firstIndex, witness));
}

async function payOperatorFee(input: {
  txSkeleton: ReturnType<typeof helpers.TransactionSkeleton>;
  operator: ReturnType<typeof operatorSigner>;
  feeMinor: bigint;
  excludedOutPoints: Set<string>;
}): Promise<ReturnType<typeof helpers.TransactionSkeleton>> {
  const feeCells = await listOperatorFeeCells(input.operator.lock, input.excludedOutPoints);
  const minChangeMinor = minimalPlainCellCapacityMinor(input.operator.lock);
  let total = 0n;
  const selected: Cell[] = [];

  for (const cell of feeCells) {
    selected.push(cell);
    total += parseCapacity(cell.cellOutput.capacity);
    const change = total - input.feeMinor;
    if (change === 0n || change >= minChangeMinor) break;
  }

  const change = total - input.feeMinor;
  if (selected.length === 0 || change < 0n || (change > 0n && change < minChangeMinor)) {
    throw new ApiError(402, 'OPERATOR_FEE_CAPACITY_INSUFFICIENT', 'Operator fee wallet does not have enough plain CKB cells for the vault payout fee.');
  }

  let txSkeleton = addCellDepOnce(input.txSkeleton, secpCellDep());
  for (const cell of selected) {
    txSkeleton = txSkeleton.update('inputs', (inputs) => inputs.push(cell));
    txSkeleton = txSkeleton.update('witnesses', (witnesses) => witnesses.push('0x'));
  }

  if (change > 0n) {
    txSkeleton = txSkeleton.update('outputs', (outputs) => outputs.push({
      cellOutput: {
        capacity: toHex(change),
        lock: input.operator.lock,
        type: undefined
      },
      data: '0x'
    }));
  }

  return setSecpSigningWitness(txSkeleton, input.operator.lockHash);
}

function selectVaultCells(input: { cells: Cell[]; amountMinor: bigint; minChangeMinor: bigint }): { selected: Cell[]; total: bigint; change: bigint } {
  let total = 0n;
  const selected: Cell[] = [];
  for (const cell of input.cells) {
    selected.push(cell);
    total += parseCapacity(cell.cellOutput.capacity);
    const change = total - input.amountMinor;
    if (change === 0n || change >= input.minChangeMinor) {
      return { selected, total, change };
    }
  }

  throw new ApiError(402, 'VAULT_LIVE_CAPACITY_INSUFFICIENT', 'Vault live cells do not have enough spendable CKB for this payout plus change capacity.');
}

async function executeVaultPlainTransfer(input: {
  ownerWalletId: string;
  recipientAddress: string;
  amountMinor: number;
  currency: string;
  minimumErrorCode: string;
  minimumErrorLabel: string;
  failureCode: string;
  failureLabel: string;
}): Promise<VaultPayoutResult> {
  const runtime = getVaultRuntimeConfig();
  if (!runtime.configured) {
    throw new ApiError(503, 'VAULT_PAYOUT_NOT_CONFIGURED', 'Direct vault payouts require the deployed FiberPass vault configuration.');
  }

  const operator = operatorSigner();
  const vaultDep = vaultCellDep();
  const wallet = await WalletModel.findOne({ walletId: input.ownerWalletId }).select('address').lean<{ address: string }>();
  const vault = wallet
    ? deriveVaultForWallet({ walletId: input.ownerWalletId, walletAddress: wallet.address })
    : null;
  if (!vault) {
    throw new ApiError(503, 'USER_VAULT_NOT_CONFIGURED', 'This wallet does not have a configured FiberPass vault.');
  }

  const minRecipientMinor = minimalRecipientCapacityMinor(input.recipientAddress);
  if (input.amountMinor < minRecipientMinor) {
    throw new ApiError(
      400,
      input.minimumErrorCode,
      input.minimumErrorLabel + ' must be at least ' + fromMinorUnits(minRecipientMinor, input.currency).toLocaleString('en-US') + ' ' + input.currency + '.'
    );
  }

  const amountMinor = BigInt(input.amountMinor);
  const recipientLock = parseCkbAddress(input.recipientAddress);
  const minVaultChangeMinor = BigInt(minimalVaultCellCapacityShannons(vault.script));
  const cells = await listVaultCells(vault.script);
  if (cells.length === 0) {
    throw new ApiError(402, 'VAULT_LIVE_CELLS_NOT_FOUND', 'No live CKB vault cells were found for this wallet.');
  }

  const { selected, change } = selectVaultCells({ cells, amountMinor, minChangeMinor: minVaultChangeMinor });
  const indexer = new Indexer(ckbIndexerUrl(), ckbRpcUrl());
  const rpc = new RPC(ckbRpcUrl());
  let txSkeleton = helpers.TransactionSkeleton({ cellProvider: indexer });
  txSkeleton = addCellDepOnce(txSkeleton, vaultDep);

  for (const cell of selected) {
    txSkeleton = txSkeleton.update('inputs', (inputs) => inputs.push(cell));
    txSkeleton = txSkeleton.update('witnesses', (witnesses) => witnesses.push(VAULT_OPERATOR_PAYOUT_WITNESS));
  }

  txSkeleton = txSkeleton.update('outputs', (outputs) => outputs.push({
    cellOutput: {
      capacity: toHex(amountMinor),
      lock: recipientLock,
      type: undefined
    },
    data: '0x'
  }));

  if (change > 0n) {
    txSkeleton = txSkeleton.update('outputs', (outputs) => outputs.push({
      cellOutput: {
        capacity: toHex(change),
        lock: vault.script,
        type: undefined
      },
      data: '0x'
    }));
  }

  try {
    const excludedOutPoints = new Set<string>();
    for (const cell of selected) {
      const key = outPointKey(cell.outPoint);
      if (key) excludedOutPoints.add(key);
    }
    excludedOutPoints.add(outPointKey(vaultDep.outPoint) ?? '');
    txSkeleton = await payOperatorFee({ txSkeleton, operator, feeMinor: DEFAULT_OPERATOR_FEE_SHANNONS, excludedOutPoints });
    txSkeleton = commons.secp256k1Blake160.prepareSigningEntries(txSkeleton, { config: networkConfig() });
    const signingEntries = txSkeleton.get('signingEntries').toArray() as Array<{ message: string }>;
    const signatures = signingEntries.map((entry) => hd.key.signRecoverable(entry.message, operator.privateKey));
    const tx = helpers.sealTransaction(txSkeleton, signatures);
    const txHash = await rpc.sendTransaction(tx, 'passthrough');
    return { provider: 'ckb-vault', network: env.FIBER_NETWORK, proofId: txHash };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error && error.message ? error.message : input.failureLabel + ' transaction failed.';
    throw new ApiError(502, input.failureCode, message);
  }
}


async function executePlainSecpTransfer(input: {
  signer: SecpSigner;
  recipientAddress: string;
  amountMinor: number;
  currency: string;
  minimumErrorCode: string;
  minimumErrorLabel: string;
  insufficientCode: string;
  insufficientLabel: string;
  failureCode: string;
  failureLabel: string;
  provider: VaultPayoutResult['provider'];
}): Promise<VaultPayoutResult> {
  const minRecipientMinor = minimalRecipientCapacityMinor(input.recipientAddress);
  if (input.amountMinor < minRecipientMinor) {
    throw new ApiError(
      400,
      input.minimumErrorCode,
      input.minimumErrorLabel + ' must be at least ' + fromMinorUnits(minRecipientMinor, input.currency).toLocaleString('en-US') + ' ' + input.currency + '.'
    );
  }

  const recipientLock = parseCkbAddress(input.recipientAddress);
  const amountMinor = BigInt(input.amountMinor);
  const feeMinor = DEFAULT_OPERATOR_FEE_SHANNONS;
  const requiredMinor = amountMinor + feeMinor;
  const minChangeMinor = minimalPlainCellCapacityMinor(input.signer.lock);
  const cells = await listOperatorFeeCells(input.signer.lock, new Set());
  let selected: Cell[] = [];
  let change = 0n;
  try {
    const selection = selectVaultCells({ cells, amountMinor: requiredMinor, minChangeMinor });
    selected = selection.selected;
    change = selection.change;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'VAULT_LIVE_CAPACITY_INSUFFICIENT') {
      throw new ApiError(402, input.insufficientCode, input.insufficientLabel);
    }
    throw error;
  }
  const indexer = new Indexer(ckbIndexerUrl(), ckbRpcUrl());
  const rpc = new RPC(ckbRpcUrl());
  let txSkeleton = helpers.TransactionSkeleton({ cellProvider: indexer });
  txSkeleton = addCellDepOnce(txSkeleton, secpCellDep());

  for (const cell of selected) {
    txSkeleton = txSkeleton.update('inputs', (inputs) => inputs.push(cell));
    txSkeleton = txSkeleton.update('witnesses', (witnesses) => witnesses.push('0x'));
  }

  txSkeleton = txSkeleton.update('outputs', (outputs) => outputs.push({
    cellOutput: {
      capacity: toHex(amountMinor),
      lock: recipientLock,
      type: undefined
    },
    data: '0x'
  }));

  if (change > 0n) {
    txSkeleton = txSkeleton.update('outputs', (outputs) => outputs.push({
      cellOutput: {
        capacity: toHex(change),
        lock: input.signer.lock,
        type: undefined
      },
      data: '0x'
    }));
  }

  try {
    txSkeleton = setSecpSigningWitness(txSkeleton, input.signer.lockHash);
    txSkeleton = commons.secp256k1Blake160.prepareSigningEntries(txSkeleton, { config: networkConfig() });
    const signingEntries = txSkeleton.get('signingEntries').toArray() as Array<{ message: string }>;
    const signatures = signingEntries.map((entry) => hd.key.signRecoverable(entry.message, input.signer.privateKey));
    const tx = helpers.sealTransaction(txSkeleton, signatures);
    const txHash = await rpc.sendTransaction(tx, 'passthrough');
    return { provider: input.provider, network: env.FIBER_NETWORK, proofId: txHash };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error && error.message ? error.message : input.failureLabel + ' transaction failed.';
    if (/capacity|insufficient/i.test(message)) {
      throw new ApiError(402, input.insufficientCode, input.insufficientLabel);
    }
    throw new ApiError(502, input.failureCode, message);
  }
}

export function getFiberExitSettlementReadiness(): VaultPayoutReadiness {
  try {
    exitSettlementSigner();
    return { ready: true };
  } catch (error) {
    if (error instanceof ApiError) return { ready: false, code: error.code, message: error.message };
    const message = error instanceof Error && error.message ? error.message : 'Fiber exit settlement configuration is not ready.';
    return { ready: false, code: 'FIBER_EXIT_SETTLEMENT_NOT_READY', message };
  }
}

export async function executeFiberExitSettlement(input: Omit<VaultPayoutInput, 'ownerWalletId' | 'sessionId'>): Promise<VaultPayoutResult> {
  return executePlainSecpTransfer({
    signer: exitSettlementSigner(),
    recipientAddress: input.recipientAddress,
    amountMinor: input.amountMinor,
    currency: input.currency,
    minimumErrorCode: 'FIBER_EXIT_SETTLEMENT_BELOW_CELL_MINIMUM',
    minimumErrorLabel: 'Fiber exit CKB settlements',
    insufficientCode: 'FIBER_EXIT_SETTLEMENT_CAPACITY_INSUFFICIENT',
    insufficientLabel: 'Fiber exit settlement wallet does not have enough plain CKB cells for this payout plus transaction fee.',
    failureCode: 'FIBER_EXIT_SETTLEMENT_TX_FAILED',
    failureLabel: 'Fiber exit CKB settlement',
    provider: 'ckb-exit'
  });
}

export async function executeVaultPayout(input: VaultPayoutInput): Promise<VaultPayoutResult> {
  return executeVaultPlainTransfer({
    ownerWalletId: input.ownerWalletId,
    recipientAddress: input.recipientAddress,
    amountMinor: input.amountMinor,
    currency: input.currency,
    minimumErrorCode: 'CKB_PAYOUT_BELOW_CELL_MINIMUM',
    minimumErrorLabel: 'Direct CKB payouts to a wallet',
    failureCode: 'VAULT_PAYOUT_TX_FAILED',
    failureLabel: 'CKB vault payout'
  });
}

export async function executeVaultLiquidityBridge(input: VaultLiquidityBridgeInput): Promise<VaultPayoutResult> {
  return executeVaultPlainTransfer({
    ownerWalletId: input.ownerWalletId,
    recipientAddress: input.nodeFundingAddress,
    amountMinor: input.amountMinor,
    currency: input.currency,
    minimumErrorCode: 'FIBER_LIQUIDITY_BELOW_CELL_MINIMUM',
    minimumErrorLabel: 'Fiber liquidity bridge transfers',
    failureCode: 'FIBER_LIQUIDITY_BRIDGE_TX_FAILED',
    failureLabel: 'Fiber liquidity bridge'
  });
}
