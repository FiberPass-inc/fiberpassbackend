import { createHash, randomUUID } from 'node:crypto';
import {
  assertMeteredGrantLimits,
  meteredBatchKey,
  nextRateWindow,
  type MeteredExecutor
} from '../domain/meteredPayment.js';
import { asAssetId, type PaymentRail } from '../domain/payment.js';
import { ApiError } from '../lib/errors.js';
import {
  asAtomicAmount,
  atomicAmountFromBigInt,
  fromMinorUnits,
  parseAtomicAmount
} from '../lib/money.js';
import { AppModel, type AppRecord } from '../models/app.model.js';
import { BtcpayConnectionModel } from '../models/bitcoin.model.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { PaymentDestinationModel, type PaymentDestinationRecord } from '../models/identity.model.js';
import {
  MeteredBatchModel,
  MeteredGrantModel,
  MeteredRateCounterModel,
  UsageEventModel,
  type MeteredBatchRecord,
  type MeteredGrantRecord,
  type UsageEventRecord
} from '../models/meteredPayment.model.js';
import { SessionModel, type SessionRecord } from '../models/session.model.js';
import { NwcConnectionModel } from '../models/nwc.model.js';
import { writeAuditLog } from './audit.service.js';
import { requiredBtcpayPermissions } from '../domain/bitcoin.js';

const MAX_TRANSACTION_RETRIES = 5;
const MAX_SAFE_ATOMIC = BigInt(Number.MAX_SAFE_INTEGER);

export interface MeteredActor {
  appId: string;
  ownerWalletId: string;
  source: 'wallet' | 'app_api_key';
  keyId?: string;
}

export interface CreateMeteredGrantInput {
  sessionId: string;
  recipientId: string;
  destinationId: string;
  rail: PaymentRail;
  network: string;
  assetId: string;
  executor: MeteredExecutor;
  connectionId?: string;
  maxPerEventAtomic: string;
  totalLimitAtomic: string;
  rateLimitCount: number;
  rateLimitWindowSeconds: number;
  immediateThresholdAtomic: string;
  maxBatchAtomic: string;
  maxBatchEvents: number;
  settlementDelayMs: number;
  expiresAt: string;
}

export interface SubmitUsageEventInput {
  grantId: string;
  externalId: string;
  amountAtomic: string;
  type?: string;
  policyReference?: string;
  metadata?: Record<string, unknown>;
}

export interface MeteredGrantDto {
  contractVersion: '2.0';
  id: string;
  appId: string;
  sessionId: string;
  recipientId: string;
  destinationId: string;
  rail: string;
  network: string;
  assetId: string;
  executor: string;
  connectionId?: string;
  status: string;
  maxPerEventAtomic: string;
  totalLimitAtomic: string;
  reservedAtomic: string;
  spentAtomic: string;
  remainingAtomic: string;
  rateLimitCount: number;
  rateLimitWindowSeconds: number;
  immediateThresholdAtomic: string;
  maxBatchAtomic: string;
  maxBatchEvents: number;
  settlementDelayMs: number;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}

export interface UsageEventDto {
  contractVersion: '2.0';
  id: string;
  externalId: string;
  appId: string;
  grantId: string;
  sessionId: string;
  recipientId: string;
  destinationId: string;
  rail: string;
  network: string;
  assetId: string;
  amountAtomic: string;
  type: string;
  policyReference: string;
  batchId?: string;
  status: string;
  metadata?: Record<string, unknown>;
  acceptedAt: string;
  receipt: {
    id: string;
    status: string;
    proofKind?: string;
    proofReference?: string;
    paymentRequestHash?: string;
    settledAt?: string;
    releasedAt?: string;
    failure?: { code: string; message?: string };
  };
}

export interface MeteredBatchDto {
  contractVersion: '2.0';
  id: string;
  grantId: string;
  sessionId: string;
  recipientId: string;
  destinationId: string;
  rail: string;
  network: string;
  assetId: string;
  executor: string;
  status: string;
  totalAtomic: string;
  eventCount: number;
  attempts: number;
  runAfter: string;
  submittedAt?: string;
  completedAt?: string;
  paymentRequestHash?: string;
  paymentHash?: string;
  providerPaymentId?: string;
  proofKind?: string;
  proofReference?: string;
  failure?: { code: string; message?: string };
}

export function newMeteredId(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 20);
}

export function meteredHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isMeteredDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 11000);
}

export function exactMeteredAmount(value: unknown, field: string, positive = false): string {
  let normalized: string;
  try {
    normalized = asAtomicAmount(value);
  } catch {
    throw new ApiError(400, 'METERED_ATOMIC_AMOUNT_INVALID', field + ' must be a canonical non-negative atomic-unit string.');
  }
  if (positive && parseAtomicAmount(normalized) <= 0n) {
    throw new ApiError(400, 'METERED_ATOMIC_AMOUNT_INVALID', field + ' must be greater than zero.');
  }
  return normalized;
}

export function safeMeteredAtomicNumber(value: bigint, field: string): number {
  if (value < 0n || value > MAX_SAFE_ATOMIC) {
    throw new ApiError(400, 'METERED_LEGACY_LEDGER_LIMIT', field + ' exceeds the current pass ledger compatibility range.');
  }
  return Number(value);
}

function recordMetadata(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function sessionAtomic(session: SessionRecord, field: 'limit' | 'spent' | 'reserved'): bigint {
  const atomic = session[(field + 'Atomic') as keyof SessionRecord];
  if (typeof atomic === 'string') return parseAtomicAmount(atomic);
  const minor = session[(field + 'Minor') as keyof SessionRecord];
  return BigInt(typeof minor === 'number' && Number.isSafeInteger(minor) ? minor : 0);
}

export function setSessionAtomic(session: any, field: 'spent' | 'reserved', value: bigint): void {
  const minor = safeMeteredAtomicNumber(value, 'Session ' + field);
  session.set(field + 'Atomic', atomicAmountFromBigInt(value));
  session.set(field + 'Minor', minor);
  if (field === 'spent') session.set('spent', fromMinorUnits(minor, session.currency));
}

export function meteredGrantRemaining(grant: MeteredGrantRecord): bigint {
  return parseAtomicAmount(grant.totalLimitAtomic)
    - parseAtomicAmount(grant.spentAtomic)
    - parseAtomicAmount(grant.reservedAtomic);
}

function usageRequestFingerprint(input: {
  appId: string;
  grantId: string;
  externalId: string;
  amountAtomic: string;
  type: string;
  policyReference: string;
}): string {
  return meteredHash(JSON.stringify(input));
}

export function toMeteredGrantDto(record: MeteredGrantRecord & { createdAt?: Date }): MeteredGrantDto {
  const remaining = meteredGrantRemaining(record);
  return {
    contractVersion: '2.0',
    id: record.grantId,
    appId: record.appId,
    sessionId: record.sessionId,
    recipientId: record.recipientId,
    destinationId: record.destinationId,
    rail: record.rail,
    network: record.network,
    assetId: record.assetId,
    executor: record.executor,
    connectionId: record.connectionId ?? undefined,
    status: record.status,
    maxPerEventAtomic: record.maxPerEventAtomic,
    totalLimitAtomic: record.totalLimitAtomic,
    reservedAtomic: record.reservedAtomic,
    spentAtomic: record.spentAtomic,
    remainingAtomic: atomicAmountFromBigInt(remaining < 0n ? 0n : remaining),
    rateLimitCount: record.rateLimitCount,
    rateLimitWindowSeconds: record.rateLimitWindowSeconds,
    immediateThresholdAtomic: record.immediateThresholdAtomic,
    maxBatchAtomic: record.maxBatchAtomic,
    maxBatchEvents: record.maxBatchEvents,
    settlementDelayMs: record.settlementDelayMs,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    revokedAt: record.revokedAt?.toISOString()
  };
}

export function toUsageEventDto(record: UsageEventRecord): UsageEventDto {
  return {
    contractVersion: '2.0',
    id: record.eventId,
    externalId: record.externalId,
    appId: record.appId,
    grantId: record.grantId,
    sessionId: record.sessionId,
    recipientId: record.recipientId,
    destinationId: record.destinationId,
    rail: record.rail,
    network: record.network,
    assetId: record.assetId,
    amountAtomic: record.amountAtomic,
    type: record.type,
    policyReference: record.policyReference,
    batchId: record.batchId ?? undefined,
    status: record.status,
    metadata: recordMetadata(record.metadata),
    acceptedAt: record.acceptedAt.toISOString(),
    receipt: {
      id: record.receiptId,
      status: record.status,
      proofKind: record.proofKind ?? undefined,
      proofReference: record.proofReference ?? undefined,
      paymentRequestHash: record.paymentRequestHash ?? undefined,
      settledAt: record.settledAt?.toISOString(),
      releasedAt: record.releasedAt?.toISOString(),
      failure: record.failureCode ? { code: record.failureCode, message: record.failureMessage ?? undefined } : undefined
    }
  };
}

export function toMeteredBatchDto(record: MeteredBatchRecord): MeteredBatchDto {
  return {
    contractVersion: '2.0',
    id: record.batchId,
    grantId: record.grantId,
    sessionId: record.sessionId,
    recipientId: record.recipientId,
    destinationId: record.destinationId,
    rail: record.rail,
    network: record.network,
    assetId: record.assetId,
    executor: record.executor,
    status: record.status,
    totalAtomic: record.totalAtomic,
    eventCount: record.eventCount,
    attempts: record.attempts,
    runAfter: record.runAfter.toISOString(),
    submittedAt: record.submittedAt?.toISOString(),
    completedAt: record.completedAt?.toISOString(),
    paymentRequestHash: record.paymentRequestHash ?? undefined,
    paymentHash: record.paymentHash ?? undefined,
    providerPaymentId: record.providerPaymentId ?? undefined,
    proofKind: record.proofKind ?? undefined,
    proofReference: record.proofReference ?? undefined,
    failure: record.failureCode ? { code: record.failureCode, message: record.failureMessage ?? undefined } : undefined
  };
}

export async function ensureMeteredActorApp(actor: MeteredActor): Promise<AppRecord> {
  const app = await AppModel.findOne({
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    status: 'active'
  }).lean<AppRecord | null>();
  if (!app) throw new ApiError(404, 'APP_NOT_FOUND', 'Active developer app was not found for this wallet.');
  return app;
}

function validateGrantExecutor(rail: PaymentRail, executor: MeteredExecutor, connectionId?: string): void {
  if (rail === 'lightning' && !['nwc', 'btcpay'].includes(executor)) {
    throw new ApiError(400, 'METERED_EXECUTOR_MISMATCH', 'Lightning metering requires the NWC or BTCPay executor.');
  }
  if (rail === 'fiber' && executor !== 'fiber') {
    throw new ApiError(400, 'METERED_EXECUTOR_MISMATCH', 'Fiber metering requires the Fiber executor.');
  }
  if (!['lightning', 'fiber'].includes(rail)) {
    throw new ApiError(400, 'METERED_RAIL_UNSUPPORTED', 'Metered payments currently use Lightning or Fiber channels.');
  }
  if (executor !== 'fiber' && !connectionId?.trim()) {
    throw new ApiError(400, 'METERED_CONNECTION_REQUIRED', 'The selected metered executor requires a scoped connection.');
  }
}

function connectionScopeMatches(
  connection: { scopeType: string; scopeId: string },
  actor: MeteredActor,
  sessionId: string
): boolean {
  if (connection.scopeType === 'wallet') return connection.scopeId === actor.ownerWalletId;
  if (connection.scopeType === 'pass') return connection.scopeId === sessionId;
  if (connection.scopeType === 'app') return connection.scopeId === actor.appId;
  return false;
}

async function validateExecutorConnection(input: {
  actor: MeteredActor;
  sessionId: string;
  executor: MeteredExecutor;
  connectionId?: string;
  network: string;
  assetId: string;
  maxBatchAtomic: string;
}): Promise<void> {
  if (input.executor === 'fiber') return;
  if (input.executor === 'nwc') {
    const connection = await NwcConnectionModel.findOne({
      connectionId: input.connectionId,
      ownerWalletId: input.actor.ownerWalletId,
      status: 'active'
    }).lean();
    if (!connection || !connectionScopeMatches(connection, input.actor, input.sessionId)) {
      throw new ApiError(403, 'METERED_CONNECTION_SCOPE_INVALID', 'NWC connection is not scoped to this wallet, pass, or app.');
    }
    if (
      connection.network !== input.network
      || connection.assetId !== input.assetId
      || connection.executionMode !== 'unattended'
      || !connection.allowanceEnforced
      || !connection.allowanceProofEventId
      || !connection.methods.includes('pay_invoice')
      || !connection.methods.includes('lookup_invoice')
    ) {
      throw new ApiError(409, 'METERED_NWC_CAPABILITY_INVALID', 'NWC connection lacks the network, allowance, pay, lookup, or unattended capability required for metering.');
    }
    const remaining = parseAtomicAmount(connection.allowanceAtomic) - parseAtomicAmount(connection.allowanceUsedAtomic);
    if (remaining < parseAtomicAmount(input.maxBatchAtomic)) {
      throw new ApiError(402, 'METERED_NWC_ALLOWANCE_INSUFFICIENT', 'NWC wallet allowance cannot cover one maximum metered batch.');
    }
    return;
  }
  const connection = await BtcpayConnectionModel.findOne({
    connectionId: input.connectionId,
    ownerWalletId: input.actor.ownerWalletId,
    status: 'active'
  }).lean();
  if (!connection || !connectionScopeMatches(connection, input.actor, input.sessionId)) {
    throw new ApiError(403, 'METERED_CONNECTION_SCOPE_INVALID', 'BTCPay connection is not scoped to this wallet, pass, or app.');
  }
  const permissions = requiredBtcpayPermissions(connection.storeId);
  if (
    connection.network !== input.network
    || !permissions.every((permission) => connection.permissions.includes(permission))
  ) {
    throw new ApiError(409, 'METERED_BTCPAY_CAPABILITY_INVALID', 'BTCPay connection lacks the network or least-privilege permissions required for metering.');
  }
}

function assertOwnerBoundSession(session: SessionRecord, actor: MeteredActor, now = new Date()): void {
  if (
    session.status !== 'active'
    || session.appId !== actor.appId
    || session.appGrantOwnerWalletId !== actor.ownerWalletId
    || !session.appPermissions?.includes('charges:create')
    || !session.autoMicroCharges
    || (session.expiryAt && session.expiryAt.getTime() <= now.getTime())
  ) {
    throw new ApiError(403, 'METERED_APP_GRANT_INVALID', 'The pass does not authorize this owner-bound application grant.');
  }
}

export async function createMeteredGrant(actor: MeteredActor, input: CreateMeteredGrantInput): Promise<MeteredGrantDto> {
  if (actor.source !== 'wallet') {
    throw new ApiError(403, 'METERED_GRANT_OWNER_REQUIRED', 'Only the wallet owner can create a metered grant.');
  }
  await ensureMeteredActorApp(actor);
  const maxPerEventAtomic = exactMeteredAmount(input.maxPerEventAtomic, 'maxPerEventAtomic', true);
  const totalLimitAtomic = exactMeteredAmount(input.totalLimitAtomic, 'totalLimitAtomic', true);
  const immediateThresholdAtomic = exactMeteredAmount(input.immediateThresholdAtomic, 'immediateThresholdAtomic', true);
  const maxBatchAtomic = exactMeteredAmount(input.maxBatchAtomic, 'maxBatchAtomic', true);
  try {
    assertMeteredGrantLimits({
      maxPerEventAtomic: asAtomicAmount(maxPerEventAtomic),
      totalLimitAtomic: asAtomicAmount(totalLimitAtomic),
      immediateThresholdAtomic: asAtomicAmount(immediateThresholdAtomic),
      maxBatchAtomic: asAtomicAmount(maxBatchAtomic)
    });
  } catch (error) {
    throw new ApiError(400, 'METERED_GRANT_LIMITS_INVALID', error instanceof Error ? error.message : 'Metered grant limits are invalid.');
  }
  validateGrantExecutor(input.rail, input.executor, input.connectionId);
  const expiresAt = new Date(input.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new ApiError(400, 'METERED_GRANT_EXPIRY_INVALID', 'Metered grant expiry must be in the future.');
  }
  const assetId = asAssetId(input.assetId);
  const [session, destination] = await Promise.all([
    SessionModel.findOne({ publicId: input.sessionId, ownerWalletId: actor.ownerWalletId }).lean<SessionRecord | null>(),
    PaymentDestinationModel.findOne({
      destinationId: input.destinationId,
      recipientId: input.recipientId,
      ownerWalletId: actor.ownerWalletId,
      status: 'active',
      reusable: true
    }).lean<PaymentDestinationRecord | null>()
  ]);
  if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'FiberPass session was not found.');
  assertOwnerBoundSession(session, actor);
  if (session.expiryAt && expiresAt.getTime() > session.expiryAt.getTime()) {
    throw new ApiError(400, 'METERED_GRANT_EXPIRY_INVALID', 'Metered grant cannot outlive its FiberPass session.');
  }
  if (!destination) {
    throw new ApiError(404, 'METERED_DESTINATION_NOT_FOUND', 'Active reusable payment destination was not found.');
  }
  if (destination.kind === 'invoice' || destination.kind === 'address') {
    throw new ApiError(400, 'METERED_REUSABLE_DESTINATION_REQUIRED', 'Metered grants require an endpoint, offer, LNURL, or Lightning Address.');
  }
  if (
    destination.rail !== input.rail
    || destination.network.toLowerCase() !== input.network.toLowerCase()
    || destination.assetId !== assetId
  ) {
    throw new ApiError(409, 'METERED_DESTINATION_MISMATCH', 'Destination rail, network, or asset does not match the grant.');
  }
  const sessionAssetId = session.assetId ?? (session.currency === 'BTC' ? 'bitcoin:btc' : 'ckb:ckb');
  if (sessionAssetId !== assetId) {
    throw new ApiError(409, 'METERED_SESSION_ASSET_MISMATCH', 'Pass asset does not match the metered grant.');
  }
  if (parseAtomicAmount(totalLimitAtomic) > sessionAtomic(session, 'limit')) {
    throw new ApiError(400, 'METERED_GRANT_LIMIT_EXCEEDED', 'Metered grant total cannot exceed the pass limit.');
  }
  await validateExecutorConnection({
    actor,
    sessionId: input.sessionId,
    executor: input.executor,
    connectionId: input.connectionId,
    network: input.network.trim().toLowerCase(),
    assetId,
    maxBatchAtomic
  });
  const grant = await MeteredGrantModel.create({
    grantId: newMeteredId('fp_mg_'),
    ownerWalletId: actor.ownerWalletId,
    appId: actor.appId,
    sessionId: input.sessionId,
    recipientId: input.recipientId,
    destinationId: input.destinationId,
    rail: input.rail,
    network: input.network.trim().toLowerCase(),
    assetId,
    executor: input.executor,
    connectionId: input.connectionId?.trim() || undefined,
    status: 'active',
    maxPerEventAtomic,
    totalLimitAtomic,
    reservedAtomic: '0',
    spentAtomic: '0',
    rateLimitCount: input.rateLimitCount,
    rateLimitWindowSeconds: input.rateLimitWindowSeconds,
    immediateThresholdAtomic,
    maxBatchAtomic,
    maxBatchEvents: input.maxBatchEvents,
    settlementDelayMs: input.settlementDelayMs,
    expiresAt,
    moneyContractVersion: 2
  });
  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: 'metered.grant.created',
    targetType: 'metered_grant',
    targetId: grant.grantId,
    metadata: {
      appId: actor.appId,
      sessionId: input.sessionId,
      recipientId: input.recipientId,
      rail: input.rail,
      assetId
    }
  });
  return toMeteredGrantDto(grant.toObject());
}

function replayUsageEvent(existing: UsageEventRecord, fingerprint: string): UsageEventDto {
  if (existing.requestFingerprint !== fingerprint) {
    throw new ApiError(409, 'USAGE_EVENT_IDEMPOTENCY_CONFLICT', 'External id was already used for a different usage event.');
  }
  return toUsageEventDto(existing);
}

async function acceptUsageEventOnce(actor: MeteredActor, input: SubmitUsageEventInput, now: Date): Promise<UsageEventDto> {
  const externalId = input.externalId.trim();
  const amountAtomic = exactMeteredAmount(input.amountAtomic, 'amountAtomic', true);
  const amount = parseAtomicAmount(amountAtomic);
  const amountMinor = safeMeteredAtomicNumber(amount, 'Usage event amount');
  const type = input.type?.trim() || 'Metered usage';
  const policyReference = input.policyReference?.trim() || input.grantId;
  const fingerprint = usageRequestFingerprint({
    appId: actor.appId,
    grantId: input.grantId,
    externalId,
    amountAtomic,
    type,
    policyReference
  });
  const replay = await UsageEventModel.findOne({ appId: actor.appId, externalId }).lean<UsageEventRecord | null>();
  if (replay) return replayUsageEvent(replay, fingerprint);

  let accepted: UsageEventRecord | undefined;
  await UsageEventModel.db.transaction(async (mongoSession) => {
    const duplicate = await UsageEventModel.findOne({ appId: actor.appId, externalId })
      .session(mongoSession).lean<UsageEventRecord | null>();
    if (duplicate) {
      accepted = duplicate;
      return;
    }
    const grant = await MeteredGrantModel.findOne({
      grantId: input.grantId,
      appId: actor.appId,
      ownerWalletId: actor.ownerWalletId
    }).session(mongoSession);
    if (!grant) throw new ApiError(404, 'METERED_GRANT_NOT_FOUND', 'Metered grant was not found for this app.');
    if (grant.status !== 'active') throw new ApiError(409, 'METERED_GRANT_INACTIVE', 'Metered grant is not active.');
    if (grant.expiresAt.getTime() <= now.getTime()) {
      grant.status = 'expired';
      await grant.save({ session: mongoSession });
      throw new ApiError(410, 'METERED_GRANT_EXPIRED', 'Metered grant has expired.');
    }
    if (amount > parseAtomicAmount(grant.maxPerEventAtomic)) {
      throw new ApiError(402, 'METERED_PER_EVENT_LIMIT_EXCEEDED', 'Usage event exceeds the grant per-event maximum.');
    }
    if (amount > meteredGrantRemaining(grant.toObject())) {
      throw new ApiError(402, 'METERED_GRANT_LIMIT_EXCEEDED', 'Usage event exceeds the remaining metered grant.');
    }
    const session = await SessionModel.findOne({
      publicId: grant.sessionId,
      ownerWalletId: actor.ownerWalletId
    }).session(mongoSession);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'FiberPass session was not found.');
    assertOwnerBoundSession(session.toObject(), actor, now);
    const sessionRecord = session.toObject() as SessionRecord;
    const nextSessionReserved = sessionAtomic(sessionRecord, 'reserved') + amount;
    if (sessionAtomic(sessionRecord, 'spent') + nextSessionReserved > sessionAtomic(sessionRecord, 'limit')) {
      throw new ApiError(402, 'SESSION_LIMIT_EXCEEDED', 'Usage event exceeds pass balance available after reservations.');
    }

    const rateWindow = nextRateWindow(now, grant.rateLimitWindowSeconds);
    let rateCounter = await MeteredRateCounterModel.findOne({
      grantId: grant.grantId,
      windowStart: rateWindow.start
    }).session(mongoSession);
    if (!rateCounter) {
      const [created] = await MeteredRateCounterModel.create([{
        grantId: grant.grantId,
        windowStart: rateWindow.start,
        windowEnd: rateWindow.end,
        count: 0
      }], { session: mongoSession });
      rateCounter = created;
    }
    if (rateCounter.count >= grant.rateLimitCount) {
      throw new ApiError(429, 'METERED_RATE_LIMIT_EXCEEDED', 'Metered grant rate limit reached for this window.');
    }
    rateCounter.count += 1;
    await rateCounter.save({ session: mongoSession });

    const batchKey = meteredHash(meteredBatchKey({
      ownerWalletId: grant.ownerWalletId,
      appId: grant.appId,
      grantId: grant.grantId,
      sessionId: grant.sessionId,
      recipientId: grant.recipientId,
      destinationId: grant.destinationId,
      rail: grant.rail,
      network: grant.network,
      assetId: asAssetId(grant.assetId),
      executor: grant.executor,
      connectionId: grant.connectionId ?? undefined
    }));
    const immediate = amount >= parseAtomicAmount(grant.immediateThresholdAtomic);
    let batch: any;
    if (!immediate) {
      batch = await MeteredBatchModel.findOne({
        batchKey,
        accepting: true,
        grantId: grant.grantId
      }).session(mongoSession);
      if (batch && (
        batch.eventCount >= grant.maxBatchEvents
        || parseAtomicAmount(batch.totalAtomic) + amount > parseAtomicAmount(grant.maxBatchAtomic)
      )) {
        batch.accepting = false;
        batch.status = 'queued';
        batch.runAfter = now;
        await batch.save({ session: mongoSession });
        batch = undefined;
      }
    }
    if (!batch) {
      const [created] = await MeteredBatchModel.create([{
        batchId: newMeteredId('fp_mb_'),
        batchKey,
        accepting: !immediate,
        ownerWalletId: grant.ownerWalletId,
        appId: grant.appId,
        grantId: grant.grantId,
        sessionId: grant.sessionId,
        recipientId: grant.recipientId,
        destinationId: grant.destinationId,
        rail: grant.rail,
        network: grant.network,
        assetId: grant.assetId,
        executor: grant.executor,
        connectionId: grant.connectionId,
        status: immediate ? 'queued' : 'collecting',
        totalAtomic: '0',
        eventCount: 0,
        runAfter: immediate ? now : new Date(now.getTime() + grant.settlementDelayMs),
        attempts: 0,
        maxAttempts: 5,
        moneyContractVersion: 2
      }], { session: mongoSession });
      batch = created;
    }
    const nextBatchTotal = parseAtomicAmount(batch.totalAtomic) + amount;
    const nextBatchCount = batch.eventCount + 1;
    batch.totalAtomic = atomicAmountFromBigInt(nextBatchTotal);
    batch.eventCount = nextBatchCount;
    if (
      immediate
      || grant.settlementDelayMs === 0
      || nextBatchTotal >= parseAtomicAmount(grant.immediateThresholdAtomic)
      || nextBatchTotal >= parseAtomicAmount(grant.maxBatchAtomic)
      || nextBatchCount >= grant.maxBatchEvents
    ) {
      batch.accepting = false;
      batch.status = 'queued';
      batch.runAfter = now;
    }
    await batch.save({ session: mongoSession });

    const eventId = newMeteredId('fp_ue_');
    const receiptId = newMeteredId('fp_ur_');
    const reservationDay = now.toISOString().slice(0, 10);
    const [event] = await UsageEventModel.create([{
      eventId,
      receiptId,
      externalId,
      requestFingerprint: fingerprint,
      ownerWalletId: grant.ownerWalletId,
      appId: grant.appId,
      grantId: grant.grantId,
      sessionId: grant.sessionId,
      recipientId: grant.recipientId,
      destinationId: grant.destinationId,
      rail: grant.rail,
      network: grant.network,
      assetId: grant.assetId,
      amountAtomic,
      type,
      policyReference,
      metadata: input.metadata,
      batchId: batch.batchId,
      status: 'reserved',
      reservationDay,
      acceptedAt: now,
      moneyContractVersion: 2
    }], { session: mongoSession });
    await ChargeAttemptModel.create([{
      attemptId: eventId,
      sessionId: grant.sessionId,
      appId: grant.appId,
      apiKeyId: actor.keyId,
      ownerWalletId: grant.ownerWalletId,
      idempotencyKey: 'usage:' + grant.appId + ':' + externalId,
      requestFingerprint: fingerprint,
      serviceReference: externalId,
      amount: fromMinorUnits(amountMinor, session.currency),
      amountMinor,
      amountAtomic,
      currency: session.currency,
      assetId: grant.assetId,
      moneyContractVersion: 2,
      type,
      status: 'pending',
      reserveStatus: 'reserved',
      executionLayer: grant.rail === 'lightning' ? 'lightning' : 'fiber',
      providerStatus: 'not_started',
      reservationDay,
      reservedAt: now,
      metadata: {
        meteredUsageEventId: eventId,
        meteredReceiptId: receiptId,
        meteredGrantId: grant.grantId,
        meteredBatchId: batch.batchId,
        policyReference
      }
    }], { session: mongoSession });
    grant.reservedAtomic = atomicAmountFromBigInt(parseAtomicAmount(grant.reservedAtomic) + amount);
    await grant.save({ session: mongoSession });
    setSessionAtomic(session, 'reserved', nextSessionReserved);
    await session.save({ session: mongoSession });
    accepted = event.toObject();
  });
  if (!accepted) {
    throw new ApiError(503, 'USAGE_EVENT_ACCEPT_FAILED', 'Usage event transaction completed without a record.');
  }
  const dto = replayUsageEvent(accepted, fingerprint);
  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: 'metered.usage.accepted',
    targetType: 'usage_event',
    targetId: dto.id,
    metadata: {
      appId: actor.appId,
      grantId: input.grantId,
      externalId,
      amountAtomic,
      batchId: dto.batchId
    }
  });
  return dto;
}

export async function submitUsageEvent(actor: MeteredActor, input: SubmitUsageEventInput): Promise<UsageEventDto> {
  await ensureMeteredActorApp(actor);
  let lastError: unknown = new Error('Usage event contention retries exhausted.');
  for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
    try {
      return await acceptUsageEventOnce(actor, input, new Date());
    } catch (error) {
      lastError = error;
      if (!isMeteredDuplicateKey(error)) throw error;
      const existing = await UsageEventModel.findOne({
        appId: actor.appId,
        externalId: input.externalId.trim()
      }).lean<UsageEventRecord | null>();
      if (existing) {
        const type = input.type?.trim() || 'Metered usage';
        const policyReference = input.policyReference?.trim() || input.grantId;
        return replayUsageEvent(existing, usageRequestFingerprint({
          appId: actor.appId,
          grantId: input.grantId,
          externalId: input.externalId.trim(),
          amountAtomic: exactMeteredAmount(input.amountAtomic, 'amountAtomic', true),
          type,
          policyReference
        }));
      }
    }
  }
  throw lastError;
}

export async function listMeteredGrants(actor: MeteredActor): Promise<{ grants: MeteredGrantDto[] }> {
  await ensureMeteredActorApp(actor);
  const grants = await MeteredGrantModel.find({
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId
  }).sort({ createdAt: -1 }).lean<Array<MeteredGrantRecord & { createdAt?: Date }>>();
  return { grants: grants.map(toMeteredGrantDto) };
}

export async function listUsageEvents(actor: MeteredActor, grantId?: string): Promise<{ events: UsageEventDto[] }> {
  await ensureMeteredActorApp(actor);
  const events = await UsageEventModel.find({
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    ...(grantId ? { grantId } : {})
  }).sort({ acceptedAt: -1 }).limit(500).lean<UsageEventRecord[]>();
  return { events: events.map(toUsageEventDto) };
}

export async function listMeteredBatches(actor: MeteredActor, grantId?: string): Promise<{ batches: MeteredBatchDto[] }> {
  await ensureMeteredActorApp(actor);
  const batches = await MeteredBatchModel.find({
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    ...(grantId ? { grantId } : {})
  }).sort({ createdAt: -1 }).limit(200).lean<MeteredBatchRecord[]>();
  return { batches: batches.map(toMeteredBatchDto) };
}

export async function releaseMeteredBatchReservation(
  batchId: string,
  code: string,
  message: string,
  finalStatus: 'released' | 'failed' = 'released'
): Promise<void> {
  await MeteredBatchModel.db.transaction(async (mongoSession) => {
    const batch = await MeteredBatchModel.findOne({ batchId }).session(mongoSession);
    if (!batch || ['succeeded', 'released', 'failed'].includes(batch.status)) return;
    const events = await UsageEventModel.find({
      batchId,
      status: { $in: ['reserved', 'settling'] }
    }).session(mongoSession);
    const total = events.reduce((sum, event) => sum + parseAtomicAmount(event.amountAtomic), 0n);
    const grant = await MeteredGrantModel.findOne({ grantId: batch.grantId }).session(mongoSession);
    const session = await SessionModel.findOne({ publicId: batch.sessionId }).session(mongoSession);
    if (!grant || !session) throw new Error('Metered reservation owner state is missing.');
    const grantReserved = parseAtomicAmount(grant.reservedAtomic);
    const sessionReserved = sessionAtomic(session.toObject(), 'reserved');
    if (grantReserved < total || sessionReserved < total) {
      throw new Error('Metered reservation counters cannot be released consistently.');
    }
    grant.reservedAtomic = atomicAmountFromBigInt(grantReserved - total);
    setSessionAtomic(session, 'reserved', sessionReserved - total);
    await grant.save({ session: mongoSession });
    await session.save({ session: mongoSession });
    const now = new Date();
    const eventIds = events.map((event) => event.eventId);
    await UsageEventModel.updateMany(
      { eventId: { $in: eventIds } },
      {
        $set: {
          status: finalStatus === 'released' ? 'released' : 'failed',
          releasedAt: now,
          failureCode: code,
          failureMessage: message
        }
      },
      { session: mongoSession }
    );
    await ChargeAttemptModel.updateMany(
      { attemptId: { $in: eventIds }, reserveStatus: 'reserved' },
      {
        $set: {
          status: 'failed',
          reserveStatus: 'released',
          providerStatus: 'failed',
          failureCode: code,
          failureMessage: message,
          finalizedAt: now
        }
      },
      { session: mongoSession }
    );
    batch.status = finalStatus;
    batch.accepting = false;
    batch.completedAt = now;
    batch.failureCode = code;
    batch.failureMessage = message;
    batch.leaseExpiresAt = now;
    batch.leaseId = undefined;
    await batch.save({ session: mongoSession });
  });
}

export async function revokeMeteredGrant(actor: MeteredActor, grantId: string): Promise<MeteredGrantDto> {
  if (actor.source !== 'wallet') {
    throw new ApiError(403, 'METERED_GRANT_OWNER_REQUIRED', 'Only the wallet owner can revoke a metered grant.');
  }
  await ensureMeteredActorApp(actor);
  let grant = await MeteredGrantModel.findOneAndUpdate(
    { grantId, appId: actor.appId, ownerWalletId: actor.ownerWalletId, status: 'active' },
    { $set: { status: 'revoked', revokedAt: new Date() } },
    { new: true }
  );
  if (!grant) {
    grant = await MeteredGrantModel.findOne({ grantId, appId: actor.appId, ownerWalletId: actor.ownerWalletId });
    if (!grant) throw new ApiError(404, 'METERED_GRANT_NOT_FOUND', 'Metered grant was not found.');
    return toMeteredGrantDto(grant.toObject());
  }
  const releasable = await MeteredBatchModel.find({
    grantId,
    submittedAt: { $exists: false },
    status: { $in: ['collecting', 'queued', 'retrying'] }
  }).select('batchId').lean<Array<{ batchId: string }>>();
  for (const batch of releasable) {
    await releaseMeteredBatchReservation(
      batch.batchId,
      'METERED_GRANT_REVOKED',
      'Grant was revoked before settlement submission.'
    );
  }
  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: 'metered.grant.revoked',
    targetType: 'metered_grant',
    targetId: grantId,
    metadata: { appId: actor.appId, releasedBatchCount: releasable.length }
  });
  const refreshed = await MeteredGrantModel.findOne({ grantId }).lean<MeteredGrantRecord | null>();
  if (!refreshed) throw new Error('Revoked metered grant disappeared.');
  return toMeteredGrantDto(refreshed);
}
