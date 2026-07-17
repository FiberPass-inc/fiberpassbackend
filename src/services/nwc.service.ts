import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import {
  NWC_NETWORKS,
  type NwcExecutionMode,
  type NwcMethod,
  type NwcNetwork,
  type NwcScopeType
} from '../domain/nwc.js';
import { asAssetId, moneyValue, PAYMENT_CONTRACT_VERSION, type PaymentIntent, type PaymentResult } from '../domain/payment.js';
import { ApiError } from '../lib/errors.js';
import { asAtomicAmount, parseAtomicAmount } from '../lib/money.js';
import { AppModel } from '../models/app.model.js';
import { NwcConnectionModel, NwcPaymentModel, type NwcConnectionRecord, type NwcPaymentRecord } from '../models/nwc.model.js';
import { SessionModel } from '../models/session.model.js';
import { nwcConnector, NwcRemoteError, nwcFeeAtomic } from '../connectors/nwcConnector.js';
import { decodeLightningInvoice, parseNwcConnectionUri, parseNwcInfoEvent } from '../connectors/nwcProtocol.js';
import { NwcRelayTransport, NwcRequestTimeoutError, type NwcTransportResponse } from '../connectors/nwcRelayTransport.js';
import { encryptNwcSecret } from './nwcCredential.service.js';
import { writeAuditLog } from './audit.service.js';

const BTC_ASSET_ID = asAssetId('bitcoin:btc');
const BALANCE_FRESHNESS_MS = 5 * 60 * 1000;
const PAYMENT_LEASE_MS = 60_000;

export interface PairNwcConnectionInput {
  connectionUri: string;
  network: NwcNetwork;
  scopeType: NwcScopeType;
  scopeId?: string;
  executionMode: NwcExecutionMode;
}

export interface NwcConnectionDto {
  contractVersion: typeof PAYMENT_CONTRACT_VERSION;
  id: string;
  status: string;
  scope: { type: NwcScopeType; id: string };
  network: NwcNetwork;
  rail: 'lightning';
  assetId: 'bitcoin:btc';
  connectorId: 'nwc-nip47';
  encryption: string;
  methods: string[];
  notifications: string[];
  relayCount: number;
  walletKeyFingerprint: string;
  clientKeyFingerprint: string;
  execution: {
    mode: NwcExecutionMode;
    unattendedEligible: boolean;
    allowance?: {
      enforced: true;
      amountAtomic: string;
      usedAtomic: string;
      remainingAtomic: string;
      resetsAt?: string;
      proofEventId: string;
    };
    limitation?: { code: string; message: string };
  };
  balance: {
    amountAtomic: string;
    source: 'nwc_get_balance';
    guarantee: 'authorization_only' | 'balance_observed';
    observedAt?: string;
    staleAt?: string;
    stale: boolean;
  };
  lastFailure?: { code: string; message?: string };
  createdAt: string;
  revokedAt?: string;
  walletRevocationRequired: boolean;
}

export interface NwcPaymentDto {
  contractVersion: typeof PAYMENT_CONTRACT_VERSION;
  id: string;
  connectionId: string;
  status: string;
  rail: 'lightning';
  network: NwcNetwork;
  assetId: 'bitcoin:btc';
  amountAtomic: string;
  feeAtomic: string;
  paymentHash: string;
  proof?: { kind: 'payment_hash'; reference: string; preimageVerified: true; responseEventId?: string };
  failure?: { code: string; message?: string };
  submittedAt?: string;
  reconciledAt?: string;
  succeededAt?: string;
  failedAt?: string;
}

interface WalletAllowance {
  enforced: boolean;
  amountAtomic: string;
  usedAtomic: string;
  resetsAt?: Date;
  proofEventId?: string;
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 11000);
}

function keyFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function exactAtomic(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value.toString(10) : undefined;
  if (typeof value !== 'string') return undefined;
  try {
    return asAtomicAmount(value);
  } catch {
    return undefined;
  }
}

function parseAllowance(result: Record<string, unknown>, responseEventId: string): WalletAllowance {
  const budget = result.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    return { enforced: false, amountAtomic: '0', usedAtomic: '0' };
  }
  const value = budget as Record<string, unknown>;
  const amountAtomic = exactAtomic(value.total_budget ?? value.amount);
  const usedAtomic = exactAtomic(value.used_budget ?? value.used) ?? '0';
  const enforced = value.enforced === true
    && (value.unit === 'msat' || value.unit === 'millisatoshi')
    && Boolean(amountAtomic)
    && parseAtomicAmount(amountAtomic ?? '0') > parseAtomicAmount(usedAtomic);
  const resetsAtValue = typeof value.renews_at === 'number' && Number.isSafeInteger(value.renews_at)
    ? new Date(value.renews_at * 1000)
    : undefined;
  return {
    enforced,
    amountAtomic: amountAtomic ?? '0',
    usedAtomic,
    resetsAt: resetsAtValue && Number.isFinite(resetsAtValue.getTime()) ? resetsAtValue : undefined,
    proofEventId: enforced ? responseEventId : undefined
  };
}

async function assertScopeOwnership(ownerWalletId: string, scopeType: NwcScopeType, requestedScopeId?: string): Promise<string> {
  if (scopeType === 'wallet') return ownerWalletId;
  const scopeId = requestedScopeId?.trim();
  if (!scopeId) throw new ApiError(400, 'NWC_SCOPE_ID_REQUIRED', 'Pass and app NWC connections require a scope id.');
  const owned = scopeType === 'pass'
    ? await SessionModel.exists({ publicId: scopeId, ownerWalletId })
    : await AppModel.exists({ appId: scopeId, ownerWalletId, status: 'active' });
  if (!owned) throw new ApiError(404, 'NWC_SCOPE_NOT_FOUND', 'NWC connection scope was not found for this wallet.');
  return scopeId;
}

function effectiveMethods(infoMethods: NwcMethod[], result: Record<string, unknown> | undefined): NwcMethod[] {
  const methods = result?.methods;
  if (!Array.isArray(methods)) return infoMethods;
  const reported = new Set(methods.filter((method): method is string => typeof method === 'string'));
  return infoMethods.filter((method) => reported.has(method));
}

function toConnectionDto(connection: NwcConnectionRecord & { createdAt?: Date }): NwcConnectionDto {
  const stale = Boolean(connection.balanceStaleAt && connection.balanceStaleAt.getTime() <= Date.now());
  const allowanceRemaining = connection.allowanceEnforced
    ? (parseAtomicAmount(connection.allowanceAtomic) - parseAtomicAmount(connection.allowanceUsedAtomic)).toString(10)
    : '0';
  const unattendedEligible = connection.executionMode === 'unattended'
    && connection.allowanceEnforced
    && Boolean(connection.allowanceProofEventId)
    && parseAtomicAmount(allowanceRemaining) > 0n
    && connection.methods.includes('lookup_invoice');
  return {
    contractVersion: PAYMENT_CONTRACT_VERSION,
    id: connection.connectionId,
    status: connection.status,
    scope: { type: connection.scopeType, id: connection.scopeId },
    network: connection.network,
    rail: 'lightning',
    assetId: 'bitcoin:btc',
    connectorId: 'nwc-nip47',
    encryption: connection.encryption,
    methods: [...connection.methods],
    notifications: [...connection.notifications],
    relayCount: connection.relayUrls.length,
    walletKeyFingerprint: keyFingerprint(connection.walletPubkey),
    clientKeyFingerprint: connection.clientKeyFingerprint,
    execution: {
      mode: connection.executionMode,
      unattendedEligible,
      allowance: connection.allowanceEnforced && connection.allowanceProofEventId ? {
        enforced: true,
        amountAtomic: connection.allowanceAtomic,
        usedAtomic: connection.allowanceUsedAtomic,
        remainingAtomic: allowanceRemaining,
        resetsAt: connection.allowanceResetsAt?.toISOString(),
        proofEventId: connection.allowanceProofEventId
      } : undefined,
      limitation: unattendedEligible ? undefined : {
        code: 'NWC_UNATTENDED_ALLOWANCE_REQUIRED',
        message: 'Cloud unattended execution remains disabled without a wallet-signed hard allowance and lookup capability.'
      }
    },
    balance: {
      amountAtomic: connection.balanceAtomic,
      source: 'nwc_get_balance',
      guarantee: connection.balanceObservedAt ? 'balance_observed' : 'authorization_only',
      observedAt: connection.balanceObservedAt?.toISOString(),
      staleAt: connection.balanceStaleAt?.toISOString(),
      stale
    },
    lastFailure: connection.lastFailureCode ? { code: connection.lastFailureCode, message: connection.lastFailureMessage ?? undefined } : undefined,
    createdAt: (connection.createdAt ?? new Date()).toISOString(),
    revokedAt: connection.revokedAt?.toISOString(),
    walletRevocationRequired: connection.status === 'revoked'
  };
}

function toPaymentDto(payment: NwcPaymentRecord): NwcPaymentDto {
  return {
    contractVersion: PAYMENT_CONTRACT_VERSION,
    id: payment.paymentId,
    connectionId: payment.connectionId,
    status: payment.status,
    rail: 'lightning',
    network: payment.network,
    assetId: 'bitcoin:btc',
    amountAtomic: payment.amountAtomic,
    feeAtomic: payment.feeAtomic,
    paymentHash: payment.paymentHash,
    proof: payment.status === 'succeeded' && payment.preimageVerified ? {
      kind: 'payment_hash',
      reference: payment.paymentHash,
      preimageVerified: true,
      responseEventId: payment.responseEventId ?? undefined
    } : undefined,
    failure: payment.failureCode ? { code: payment.failureCode, message: payment.failureMessage ?? undefined } : undefined,
    submittedAt: payment.submittedAt?.toISOString(),
    reconciledAt: payment.reconciledAt?.toISOString(),
    succeededAt: payment.succeededAt?.toISOString(),
    failedAt: payment.failedAt?.toISOString()
  };
}

const defaultTransport = new NwcRelayTransport({
  timeoutMs: env.NWC_REQUEST_TIMEOUT_MS,
  allowInsecureLocal: env.NWC_ALLOW_INSECURE_LOCAL_RELAY
});

async function requestWalletInfo(input: {
  relay: string;
  walletPubkey: string;
  clientPubkey: string;
  secret: Uint8Array;
  encryption: NwcConnectionRecord['encryption'];
  transport: NwcRelayTransport;
}): Promise<{ result?: Record<string, unknown>; response?: NwcTransportResponse }> {
  const response = await input.transport.request({
    relay: input.relay,
    walletPubkey: input.walletPubkey,
    clientPubkey: input.clientPubkey,
    secret: input.secret,
    encryption: input.encryption,
    payload: { method: 'get_info', params: {} }
  });
  if (response.response.error) {
    throw new ApiError(409, 'NWC_GET_INFO_FAILED', 'NWC wallet rejected capability verification.');
  }
  if (!response.response.result) throw new ApiError(502, 'NWC_RESPONSE_INVALID', 'NWC wallet returned no get_info result.');
  return { result: response.response.result, response };
}

export async function pairNwcConnection(
  input: PairNwcConnectionInput,
  ownerWalletId: string,
  transport: NwcRelayTransport = defaultTransport
): Promise<NwcConnectionDto> {
  const scopeId = await assertScopeOwnership(ownerWalletId, input.scopeType, input.scopeId);
  const parsed = parseNwcConnectionUri(input.connectionUri);
  try {
    if (await NwcConnectionModel.exists({ clientPubkey: parsed.clientPubkey })) {
      throw new ApiError(409, 'NWC_CONNECTION_KEY_REUSED', 'This NWC connection key is already paired. Create a unique wallet connection.');
    }
    const discovered = await transport.fetchInfo(parsed.relays, parsed.walletPubkey);
    const info = parseNwcInfoEvent(discovered.event, parsed.walletPubkey);
    if (!info.methods.includes('pay_invoice')) {
      throw new ApiError(409, 'NWC_PAY_INVOICE_REQUIRED', 'NWC connection does not advertise invoice payment.');
    }

    let infoResult: Record<string, unknown> | undefined;
    let infoResponse: NwcTransportResponse | undefined;
    if (info.methods.includes('get_info')) {
      const verified = await requestWalletInfo({
        relay: discovered.relay,
        walletPubkey: parsed.walletPubkey,
        clientPubkey: parsed.clientPubkey,
        secret: parsed.secret,
        encryption: info.encryption,
        transport
      });
      infoResult = verified.result;
      infoResponse = verified.response;
      const reportedNetwork = typeof infoResult?.network === 'string' ? infoResult.network.toLowerCase() : undefined;
      if (reportedNetwork && (!(NWC_NETWORKS as readonly string[]).includes(reportedNetwork) || reportedNetwork !== input.network)) {
        throw new ApiError(409, 'NWC_NETWORK_MISMATCH', 'NWC wallet network does not match the requested connection network.');
      }
    }
    const methods = effectiveMethods(info.methods, infoResult);
    if (!methods.includes('pay_invoice')) throw new ApiError(409, 'NWC_PAY_INVOICE_REQUIRED', 'NWC wallet did not confirm invoice payment capability.');
    const allowance = infoResult && infoResponse
      ? parseAllowance(infoResult, infoResponse.responseEventId)
      : { enforced: false, amountAtomic: '0', usedAtomic: '0' };
    if (input.executionMode === 'unattended' && (
      !allowance.enforced
      || !allowance.proofEventId
      || !methods.includes('lookup_invoice')
    )) {
      throw new ApiError(409, 'NWC_UNATTENDED_ALLOWANCE_REQUIRED', 'Unattended NWC connections require a wallet-signed hard allowance and lookup_invoice capability.');
    }

    const now = new Date();
    const connectionId = 'nwc_' + randomUUID();
    let connection;
    try {
      connection = await NwcConnectionModel.create({
        connectionId,
        ownerWalletId,
        scopeType: input.scopeType,
        scopeId,
        status: 'active',
        executionMode: input.executionMode,
        walletPubkey: parsed.walletPubkey,
        clientPubkey: parsed.clientPubkey,
        clientKeyFingerprint: keyFingerprint(parsed.clientPubkey),
        relayUrls: parsed.relays,
        selectedRelay: discovered.relay,
        secretCiphertext: encryptNwcSecret(parsed.secret),
        encryption: info.encryption,
        methods,
        advertisedMethods: info.advertisedMethods,
        notifications: info.notifications,
        infoEventId: info.eventId,
        infoResponseEventId: infoResponse?.responseEventId,
        network: input.network,
        assetId: BTC_ASSET_ID,
        moneyContractVersion: 2,
        lud16: parsed.lud16,
        allowanceEnforced: allowance.enforced,
        allowanceAtomic: allowance.amountAtomic,
        allowanceUsedAtomic: allowance.usedAtomic,
        allowanceResetsAt: allowance.resetsAt,
        allowanceProofEventId: allowance.proofEventId,
        balanceAtomic: '0',
        lastUsedAt: infoResponse ? now : undefined
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new ApiError(409, 'NWC_CONNECTION_KEY_REUSED', 'This NWC connection key is already paired.');
      throw error;
    }
    await writeAuditLog({
      actorWalletId: ownerWalletId,
      action: 'nwc.connection.paired',
      targetType: 'nwc_connection',
      targetId: connectionId,
      metadata: {
        scopeType: input.scopeType,
        scopeId,
        network: input.network,
        executionMode: input.executionMode,
        encryption: info.encryption,
        methods,
        clientKeyFingerprint: keyFingerprint(parsed.clientPubkey)
      }
    });
    return toConnectionDto(connection.toObject());
  } finally {
    parsed.secret.fill(0);
  }
}

export async function listNwcConnections(ownerWalletId: string): Promise<{ contractVersion: string; connections: NwcConnectionDto[] }> {
  const connections = await NwcConnectionModel.find({ ownerWalletId }).sort({ createdAt: -1 }).lean<Array<NwcConnectionRecord & { createdAt?: Date }>>();
  return { contractVersion: PAYMENT_CONTRACT_VERSION, connections: connections.map(toConnectionDto) };
}

export async function syncNwcBalance(connectionId: string, ownerWalletId: string): Promise<NwcConnectionDto> {
  const balance = await nwcConnector.getBalance(connectionId, ownerWalletId);
  const observedAt = new Date();
  const connection = await NwcConnectionModel.findOneAndUpdate(
    { connectionId, ownerWalletId, status: 'active' },
    {
      $set: {
        balanceAtomic: balance.balanceAtomic,
        balanceObservedAt: observedAt,
        balanceStaleAt: new Date(observedAt.getTime() + BALANCE_FRESHNESS_MS),
        lastUsedAt: observedAt
      },
      $unset: { lastFailureCode: 1, lastFailureMessage: 1 }
    },
    { new: true }
  );
  if (!connection) throw new ApiError(404, 'NWC_CONNECTION_NOT_FOUND', 'Active NWC connection was not found.');
  await writeAuditLog({
    actorWalletId: ownerWalletId,
    action: 'nwc.balance.observed',
    targetType: 'nwc_connection',
    targetId: connectionId,
    metadata: { responseEventId: balance.responseEventId, amountAtomic: balance.balanceAtomic }
  });
  return toConnectionDto(connection.toObject());
}

export async function disconnectNwcConnection(connectionId: string, ownerWalletId: string, reason?: string): Promise<void> {
  const result = await NwcConnectionModel.updateOne(
    { connectionId, ownerWalletId, status: 'active' },
    {
      $set: {
        status: 'revoked',
        revokedAt: new Date(),
        revokeReason: reason?.trim().slice(0, 160) || 'Disconnected by owner',
        relayUrls: [],
        selectedRelay: ''
      },
      $unset: { secretCiphertext: 1 }
    }
  );
  if (result.matchedCount !== 1) throw new ApiError(404, 'NWC_CONNECTION_NOT_FOUND', 'Active NWC connection was not found.');
  await writeAuditLog({
    actorWalletId: ownerWalletId,
    action: 'nwc.connection.disconnected',
    targetType: 'nwc_connection',
    targetId: connectionId,
    metadata: { walletRevocationRequired: true }
  });
}

function paymentFingerprint(input: {
  ownerWalletId: string;
  connectionId: string;
  idempotencyKey: string;
  paymentHash: string;
  invoiceHash: string;
  amountAtomic: string;
  network: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function paymentIntent(input: {
  paymentId: string;
  idempotencyKey: string;
  invoice: string;
  network: NwcNetwork;
  amountAtomic: string;
  expiresAt: string;
}): PaymentIntent {
  return {
    intentId: input.paymentId,
    idempotencyKey: input.idempotencyKey,
    rail: 'lightning',
    network: input.network,
    money: moneyValue(BTC_ASSET_ID, input.amountAtomic),
    destination: { kind: 'invoice', rail: 'lightning', network: input.network, value: input.invoice },
    expiresAt: input.expiresAt
  };
}

function paymentExecutionInFlight(payment: NwcPaymentRecord): boolean {
  return payment.status === 'pending'
    && Boolean(payment.executionLeaseId)
    && Boolean(payment.executionLeaseExpiresAt && payment.executionLeaseExpiresAt.getTime() > Date.now());
}

async function persistNwcSuccess(paymentId: string, result: PaymentResult, reconciled: boolean): Promise<NwcPaymentRecord> {
  const now = new Date();
  const payment = await NwcPaymentModel.findOneAndUpdate(
    { paymentId, status: { $in: ['pending', 'uncertain'] } },
    {
      $set: {
        status: 'succeeded',
        feeAtomic: nwcFeeAtomic(result),
        requestEventId: result.proof?.metadata?.requestEventId,
        responseEventId: result.proof?.metadata?.responseEventId,
        preimageVerified: result.proof?.metadata?.preimageVerified === 'true',
        succeededAt: now,
        reconciledAt: reconciled ? now : undefined,
        executionLeaseExpiresAt: now
      },
      $unset: { failureCode: 1, failureMessage: 1, executionLeaseId: 1 }
    },
    { new: true }
  ).lean<NwcPaymentRecord | null>();
  if (!payment) {
    const existing = await NwcPaymentModel.findOne({ paymentId }).lean<NwcPaymentRecord | null>();
    if (existing?.status === 'succeeded') return existing;
    throw new ApiError(503, 'NWC_PAYMENT_FINALIZATION_FAILED', 'NWC payment success could not be persisted.');
  }
  return payment;
}

async function markNwcUncertain(paymentId: string, error: unknown): Promise<NwcPaymentRecord> {
  const requestEventId = error instanceof NwcRequestTimeoutError ? error.requestEventId : undefined;
  const payment = await NwcPaymentModel.findOneAndUpdate(
    { paymentId, status: { $in: ['pending', 'uncertain'] } },
    {
      $set: {
        status: 'uncertain',
        requestEventId,
        failureCode: 'NWC_PAYMENT_OUTCOME_UNCERTAIN',
        failureMessage: 'NWC payment outcome must be reconciled before retry.',
        executionLeaseExpiresAt: new Date()
      },
      $unset: { executionLeaseId: 1 }
    },
    { new: true }
  ).lean<NwcPaymentRecord | null>();
  if (!payment) throw new ApiError(503, 'NWC_PAYMENT_STATE_FAILED', 'NWC payment uncertainty could not be persisted.');
  return payment;
}

async function markNwcFailed(paymentId: string, code: string, message: string): Promise<NwcPaymentRecord> {
  const now = new Date();
  const payment = await NwcPaymentModel.findOneAndUpdate(
    { paymentId, status: { $in: ['pending', 'uncertain'] } },
    {
      $set: { status: 'failed', failureCode: code, failureMessage: message, failedAt: now, executionLeaseExpiresAt: now },
      $unset: { executionLeaseId: 1 }
    },
    { new: true }
  ).lean<NwcPaymentRecord | null>();
  if (!payment) throw new ApiError(503, 'NWC_PAYMENT_STATE_FAILED', 'NWC payment failure could not be persisted.');
  return payment;
}

async function reconcilePayment(payment: NwcPaymentRecord): Promise<NwcPaymentDto> {
  const connection = await NwcConnectionModel.findOne({ connectionId: payment.connectionId, ownerWalletId: payment.ownerWalletId, status: 'active' }).lean<NwcConnectionRecord | null>();
  if (!connection) throw new ApiError(404, 'NWC_CONNECTION_NOT_FOUND', 'Active NWC connection was not found for reconciliation.');
  if (!connection.methods.includes('lookup_invoice')) {
    throw new ApiError(409, 'NWC_RECONCILIATION_UNAVAILABLE', 'NWC wallet did not advertise lookup_invoice; the payment cannot be retried automatically.');
  }
  let result: PaymentResult;
  try {
    result = await nwcConnector.lookup({
      rail: 'lightning',
      network: payment.network,
      assetId: BTC_ASSET_ID,
      reference: payment.paymentHash,
      ownerWalletId: payment.ownerWalletId,
      connectionId: payment.connectionId
    });
  } catch (error) {
    const uncertain = await markNwcUncertain(payment.paymentId, error);
    return toPaymentDto(uncertain);
  }
  if (result.status === 'succeeded') return toPaymentDto(await persistNwcSuccess(payment.paymentId, result, true));
  if (result.status === 'failed') {
    return toPaymentDto(await markNwcFailed(
      payment.paymentId,
      result.failureCode ?? 'NWC_PAYMENT_FAILED',
      result.failureMessage ?? 'NWC wallet reports that the payment failed.'
    ));
  }
  const now = new Date();
  const uncertain = await NwcPaymentModel.findOneAndUpdate(
    { paymentId: payment.paymentId },
    { $set: { status: 'uncertain', reconciledAt: now, executionLeaseExpiresAt: now } },
    { new: true }
  ).lean<NwcPaymentRecord | null>();
  if (!uncertain) throw new ApiError(404, 'NWC_PAYMENT_NOT_FOUND', 'NWC payment attempt was not found.');
  return toPaymentDto(uncertain);
}

export async function payNwcInvoice(input: {
  connectionId: string;
  ownerWalletId: string;
  invoice: string;
  idempotencyKey: string;
}): Promise<NwcPaymentDto> {
  const connection = await NwcConnectionModel.findOne({
    connectionId: input.connectionId,
    ownerWalletId: input.ownerWalletId,
    status: 'active'
  }).lean<NwcConnectionRecord | null>();
  if (!connection) throw new ApiError(404, 'NWC_CONNECTION_NOT_FOUND', 'Active NWC connection was not found.');
  if (!connection.methods.includes('pay_invoice')) throw new ApiError(409, 'NWC_CAPABILITY_NOT_ADVERTISED', 'NWC wallet did not advertise pay_invoice.');
  const invoice = decodeLightningInvoice({ invoice: input.invoice, network: connection.network });
  const fingerprint = paymentFingerprint({
    ownerWalletId: input.ownerWalletId,
    connectionId: input.connectionId,
    idempotencyKey: input.idempotencyKey,
    paymentHash: invoice.paymentHash,
    invoiceHash: invoice.invoiceHash,
    amountAtomic: invoice.amountAtomic,
    network: connection.network
  });

  let existing = await NwcPaymentModel.findOne({
    ownerWalletId: input.ownerWalletId,
    $or: [
      { connectionId: input.connectionId, idempotencyKey: input.idempotencyKey },
      { paymentHash: invoice.paymentHash }
    ]
  }).lean<NwcPaymentRecord | null>();
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new ApiError(409, 'NWC_IDEMPOTENCY_CONFLICT', 'NWC idempotency key or invoice was already used for another payment request.');
    }
    if (existing.status === 'succeeded') return toPaymentDto(existing);
    if (existing.status === 'failed') throw new ApiError(409, existing.failureCode ?? 'NWC_PAYMENT_FAILED', existing.failureMessage ?? 'NWC payment already failed.');
    if (paymentExecutionInFlight(existing)) return toPaymentDto(existing);
    return reconcilePayment(existing);
  }

  const paymentId = 'nwcpay_' + randomUUID();
  const leaseId = randomUUID();
  try {
    const created = await NwcPaymentModel.create({
      paymentId,
      ownerWalletId: input.ownerWalletId,
      connectionId: input.connectionId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      paymentHash: invoice.paymentHash,
      invoiceHash: invoice.invoiceHash,
      network: connection.network,
      assetId: BTC_ASSET_ID,
      moneyContractVersion: 2,
      amountAtomic: invoice.amountAtomic,
      feeAtomic: '0',
      status: 'pending',
      executionMode: 'interactive',
      executionLeaseId: leaseId,
      executionLeaseExpiresAt: new Date(Date.now() + PAYMENT_LEASE_MS)
    });
    existing = created.toObject();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    existing = await NwcPaymentModel.findOne({ ownerWalletId: input.ownerWalletId, paymentHash: invoice.paymentHash }).lean<NwcPaymentRecord | null>();
    if (!existing) throw new ApiError(409, 'NWC_PAYMENT_DUPLICATE', 'NWC payment request is already being processed.');
    if (existing.requestFingerprint !== fingerprint) throw new ApiError(409, 'NWC_IDEMPOTENCY_CONFLICT', 'NWC invoice is already assigned to another request.');
    if (existing.status === 'succeeded' || paymentExecutionInFlight(existing)) return toPaymentDto(existing);
    return reconcilePayment(existing);
  }

  await NwcPaymentModel.updateOne(
    { paymentId, executionLeaseId: leaseId },
    { $set: { submittedAt: new Date() } }
  );
  const intent = paymentIntent({
    paymentId,
    idempotencyKey: input.idempotencyKey,
    invoice: invoice.invoice,
    network: connection.network,
    amountAtomic: invoice.amountAtomic,
    expiresAt: invoice.expiresAt
  });
  const quote = await nwcConnector.quote(intent);
  try {
    const result = await nwcConnector.execute(intent, quote, {
      ownerWalletId: input.ownerWalletId,
      metadata: { nwcConnectionId: input.connectionId, nwcExecutionMode: 'interactive' }
    });
    const persisted = await persistNwcSuccess(paymentId, result, false);
    await writeAuditLog({
      actorWalletId: input.ownerWalletId,
      action: 'nwc.payment.succeeded',
      targetType: 'nwc_payment',
      targetId: paymentId,
      metadata: {
        connectionId: input.connectionId,
        paymentHash: invoice.paymentHash,
        amountAtomic: invoice.amountAtomic,
        network: connection.network,
        preimageVerified: true
      }
    });
    return toPaymentDto(persisted);
  } catch (error) {
    const lookupAvailable = connection.methods.includes('lookup_invoice');
    if (error instanceof NwcRequestTimeoutError || (lookupAvailable && (
      !(error instanceof NwcRemoteError)
      || error.remoteCode === 'PAYMENT_FAILED'
      || error.remoteCode === 'INTERNAL'
    ))) {
      const uncertain = await markNwcUncertain(paymentId, error);
      await writeAuditLog({
        actorWalletId: input.ownerWalletId,
        action: 'nwc.payment.uncertain',
        targetType: 'nwc_payment',
        targetId: paymentId,
        metadata: { connectionId: input.connectionId, paymentHash: invoice.paymentHash, amountAtomic: invoice.amountAtomic }
      });
      return toPaymentDto(uncertain);
    }
    const code = error instanceof NwcRemoteError ? 'NWC_' + error.remoteCode : error instanceof ApiError ? error.code : 'NWC_PAYMENT_FAILED';
    const message = error instanceof NwcRemoteError || error instanceof ApiError
      ? error.message
      : 'NWC payment failed.';
    const failed = await markNwcFailed(paymentId, code, message);
    throw new ApiError(502, code, failed.failureMessage ?? 'NWC payment failed.');
  }
}

export async function getNwcPaymentStatus(input: {
  connectionId: string;
  ownerWalletId: string;
  paymentHash: string;
}): Promise<NwcPaymentDto> {
  const payment = await NwcPaymentModel.findOne({
    connectionId: input.connectionId,
    ownerWalletId: input.ownerWalletId,
    paymentHash: input.paymentHash.toLowerCase()
  }).lean<NwcPaymentRecord | null>();
  if (!payment) throw new ApiError(404, 'NWC_PAYMENT_NOT_FOUND', 'NWC payment attempt was not found.');
  if (payment.status === 'pending' || payment.status === 'uncertain') return reconcilePayment(payment);
  return toPaymentDto(payment);
}
