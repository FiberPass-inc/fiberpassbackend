import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { DestinationResolverClient, type ResolverTransport } from '../connectors/destinationResolverClient.js';
import { BITCOIN_NETWORKS } from '../domain/bitcoin.js';
import { DESTINATION_KINDS, type DestinationKind, type DestinationRail } from '../domain/identity.js';
import { assetIdForLegacyCurrency, PAYMENT_CONTRACT_VERSION, type PaymentRail } from '../domain/payment.js';
import {
  assertTimeZone,
  nextOccurrenceAfter,
  occurrenceLocalDay,
  stableOccurrenceId,
  type ScheduleCadence,
  type ScheduleExecutor
} from '../domain/schedule.js';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import {
  asAtomicAmount,
  atomicAmountFromBigInt,
  fallbackMinorUnits,
  formatAtomicAmount,
  getCurrencyMetadata,
  legacyMinorToAtomicAmount,
  parseAtomicAmount
} from '../lib/money.js';
import { BtcpayConnectionModel, BtcpayPaymentModel } from '../models/bitcoin.model.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import {
  PaymentDestinationModel,
  RecipientIdentityModel,
  type PaymentDestinationRecord
} from '../models/identity.model.js';
import { NwcConnectionModel, NwcPaymentModel } from '../models/nwc.model.js';
import {
  PaymentScheduleModel,
  ScheduledOccurrenceModel,
  type PaymentScheduleRecord,
  type ScheduledOccurrenceRecord
} from '../models/schedule.model.js';
import { SessionModel, type SessionRecord } from '../models/session.model.js';
import { writeAuditLog } from './audit.service.js';
import {
  decodeLnurl,
  lightningAddressUrl,
  resolveFreshPaymentRequest,
  type ReusableDestinationInput
} from './destinationResolver.service.js';
import { getBtcpayPayment, payBtcpayLightning } from './btcpay.service.js';
import { getNwcPaymentStatus, payNwcInvoice } from './nwc.service.js';
import { chargeSession } from './session.service.js';
import { hashPrivateValue, newIdentityId } from './recipientIdentity.service.js';

const OCCURRENCE_LEASE_MS = 90_000;
const RETRY_BASE_MS = 30_000;

export interface ConfigureReusableDestinationInput {
  sessionId: string;
  recipientId: string;
  rail: DestinationRail;
  network: string;
  assetId: string;
  kind: DestinationKind;
  value: string;
  resolverEndpoint?: string;
  idempotencyKey: string;
}

export interface CreatePaymentScheduleInput {
  destinationId: string;
  rail: PaymentRail;
  network: string;
  assetId: string;
  amountAtomic: string;
  maxFeeAtomic?: string;
  executor: ScheduleExecutor;
  connectionId?: string;
  cadence: ScheduleCadence;
  timeZone: string;
  firstOccurrenceAt: Date;
  customIntervalSeconds?: number;
  occurrenceLimit?: number;
  idempotencyKey: string;
}

export interface PaymentScheduleDto {
  contractVersion: typeof PAYMENT_CONTRACT_VERSION;
  id: string;
  sessionId: string;
  recipientId: string;
  destinationId: string;
  rail: string;
  network: string;
  assetId: string;
  amountAtomic: string;
  maxFeeAtomic: string;
  spentAtomic: string;
  executor: string;
  connectionId?: string;
  cadence: string;
  timeZone: string;
  anchorDay?: number;
  customIntervalSeconds?: number;
  status: string;
  nextOccurrenceAt: string;
  lastOccurrenceAt?: string;
  occurrenceLimit?: number;
  occurrenceCount: number;
  failure?: { code: string; message?: string };
  createdAt: string;
}

export interface PaymentOccurrenceDto {
  id: string;
  scheduleId: string;
  dueAt: string;
  status: string;
  amountAtomic: string;
  paymentRequestHash?: string;
  paymentHash?: string;
  executorPaymentId?: string;
  proof?: { kind: string; reference: string };
  failure?: { code: string; message?: string };
  completedAt?: string;
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 11000);
}

function requestFingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function configuredDestinationDto(destination: PaymentDestinationRecord) {
  return {
    destinationId: destination.destinationId,
    recipientId: destination.recipientId,
    kind: destination.kind,
    rail: destination.rail,
    network: destination.network,
    assetId: destination.assetId,
    reusable: true as const
  };
}

function scheduleDto(schedule: PaymentScheduleRecord & { createdAt?: Date }): PaymentScheduleDto {
  return {
    contractVersion: PAYMENT_CONTRACT_VERSION,
    id: schedule.scheduleId,
    sessionId: schedule.sessionId,
    recipientId: schedule.recipientId,
    destinationId: schedule.destinationId,
    rail: schedule.rail,
    network: schedule.network,
    assetId: schedule.assetId,
    amountAtomic: schedule.amountAtomic,
    maxFeeAtomic: schedule.maxFeeAtomic,
    spentAtomic: schedule.spentAtomic,
    executor: schedule.executor,
    connectionId: schedule.connectionId ?? undefined,
    cadence: schedule.cadence,
    timeZone: schedule.timeZone,
    anchorDay: schedule.anchorDay ?? undefined,
    customIntervalSeconds: schedule.customIntervalSeconds ?? undefined,
    status: schedule.status,
    nextOccurrenceAt: schedule.nextOccurrenceAt.toISOString(),
    lastOccurrenceAt: schedule.lastOccurrenceAt?.toISOString(),
    occurrenceLimit: schedule.occurrenceLimit ?? undefined,
    occurrenceCount: schedule.occurrenceCount,
    failure: schedule.failureCode ? { code: schedule.failureCode, message: schedule.failureMessage ?? undefined } : undefined,
    createdAt: (schedule.createdAt ?? new Date()).toISOString()
  };
}

function occurrenceDto(occurrence: ScheduledOccurrenceRecord): PaymentOccurrenceDto {
  return {
    id: occurrence.occurrenceId,
    scheduleId: occurrence.scheduleId,
    dueAt: occurrence.dueAt.toISOString(),
    status: occurrence.status,
    amountAtomic: occurrence.amountAtomic,
    paymentRequestHash: occurrence.paymentRequestHash ?? undefined,
    paymentHash: occurrence.paymentHash ?? undefined,
    executorPaymentId: occurrence.executorPaymentId ?? undefined,
    proof: occurrence.proofKind && occurrence.proofReference
      ? { kind: occurrence.proofKind, reference: occurrence.proofReference }
      : undefined,
    failure: occurrence.failureCode ? { code: occurrence.failureCode, message: occurrence.failureMessage ?? undefined } : undefined,
    completedAt: occurrence.completedAt?.toISOString()
  };
}

function normalizedDestinationValue(kind: DestinationKind, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 10_000) throw new ApiError(400, 'DESTINATION_VALUE_INVALID', 'Payment destination value is invalid.');
  if (kind === 'bolt12_offer' && !/^lno1[02-9ac-hj-np-z]+$/i.test(normalized)) {
    throw new ApiError(400, 'BOLT12_OFFER_INVALID', 'BOLT12 offer encoding is invalid.');
  }
  return normalized;
}

function assertReusableDestinationShape(input: ConfigureReusableDestinationInput): void {
  if (!(DESTINATION_KINDS as readonly string[]).includes(input.kind) || input.kind === 'invoice' || input.kind === 'address') {
    throw new ApiError(400, 'REUSABLE_DESTINATION_REQUIRED', 'Schedules require an endpoint, BOLT12 offer, LNURL, or Lightning Address.');
  }
  if (input.rail === 'lightning') {
    if (input.assetId !== 'bitcoin:btc') throw new ApiError(400, 'LIGHTNING_ASSET_UNSUPPORTED', 'Lightning schedules currently support BTC only.');
    if (!(BITCOIN_NETWORKS as readonly string[]).includes(input.network)) {
      throw new ApiError(400, 'LIGHTNING_NETWORK_INVALID', 'Lightning network is invalid.');
    }
  } else if (input.rail === 'fiber') {
    if (input.assetId !== 'ckb:ckb' || input.kind !== 'endpoint') {
      throw new ApiError(400, 'FIBER_DESTINATION_UNSUPPORTED', 'Fiber schedules require a reusable CKB Fiber endpoint.');
    }
  } else {
    throw new ApiError(400, 'SCHEDULE_RAIL_UNSUPPORTED', 'Reusable scheduled requests support Lightning and Fiber rails.');
  }
  if ((input.kind === 'lnurl' || input.kind === 'lightning_address' || input.kind === 'bolt12_offer') && input.rail !== 'lightning') {
    throw new ApiError(400, 'DESTINATION_RAIL_MISMATCH', 'This reusable destination kind requires the Lightning rail.');
  }
}

export async function configureReusablePaymentDestination(
  input: ConfigureReusableDestinationInput,
  ownerWalletId: string
): Promise<{ destinationId: string; recipientId: string; kind: string; rail: string; network: string; assetId: string; reusable: true }> {
  assertReusableDestinationShape(input);
  const value = normalizedDestinationValue(input.kind, input.value);
  const resolverEndpoint = input.resolverEndpoint?.trim() || undefined;
  const fingerprint = requestFingerprint({
    sessionId: input.sessionId,
    recipientId: input.recipientId,
    rail: input.rail,
    network: input.network,
    assetId: input.assetId,
    kind: input.kind,
    valueHash: hashPrivateValue(value),
    resolverEndpointHash: resolverEndpoint ? hashPrivateValue(resolverEndpoint) : undefined
  });
  const replay = await PaymentDestinationModel.findOne({
    ownerWalletId,
    configurationIdempotencyKey: input.idempotencyKey
  }).lean<PaymentDestinationRecord | null>();
  if (replay) {
    if (replay.configurationFingerprint !== fingerprint) {
      throw new ApiError(409, 'DESTINATION_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for another destination configuration.');
    }
    return configuredDestinationDto(replay);
  }
  if (input.kind === 'bolt12_offer' && !resolverEndpoint) {
    throw new ApiError(400, 'BOLT12_RESOLVER_REQUIRED', 'BOLT12 offers require an offer-capable resolver endpoint for BOLT11 executors.');
  }
  const urlClient = new DestinationResolverClient({
    timeoutMs: env.SCHEDULE_RESOLVER_TIMEOUT_MS,
    allowInsecureLocal: env.SCHEDULE_ALLOW_INSECURE_LOCAL_RESOLVERS
  });
  if (input.kind === 'endpoint') await urlClient.assertUrl(value);
  if (input.kind === 'lnurl') await urlClient.assertUrl(decodeLnurl(value));
  if (input.kind === 'lightning_address') await urlClient.assertUrl(lightningAddressUrl(value));
  if (resolverEndpoint) await urlClient.assertUrl(resolverEndpoint);

  const [session, recipient] = await Promise.all([
    SessionModel.findOne({ publicId: input.sessionId, ownerWalletId }).lean<SessionRecord | null>(),
    RecipientIdentityModel.findOne({ recipientId: input.recipientId, ownerWalletId, sessionId: input.sessionId }).lean()
  ]);
  if (!session || !recipient) throw new ApiError(404, 'RECIPIENT_NOT_FOUND', 'Pass recipient was not found for this wallet.');
  if (!Number.isInteger(recipient.sessionRecipientIndex) || (recipient.sessionRecipientIndex ?? -1) < 0) {
    throw new ApiError(409, 'RECIPIENT_SESSION_INDEX_MISSING', 'Recipient is not bound to a concrete pass destination slot.');
  }
  if (session.status === 'revoked' || session.status === 'settled' || session.status === 'expired') {
    throw new ApiError(409, 'SESSION_INACTIVE', 'Payment destinations cannot be changed on a closed pass.');
  }
  const sessionAssetId = session.assetId ?? assetIdForLegacyCurrency(session.currency);
  if (sessionAssetId !== input.assetId) throw new ApiError(400, 'DESTINATION_ASSET_MISMATCH', 'Destination asset does not match the pass asset.');

  const destinationId = newIdentityId('dst');
  const now = new Date();
  try {
    await PaymentDestinationModel.db.transaction(async (mongoSession) => {
      await PaymentDestinationModel.updateMany(
        { recipientId: input.recipientId, status: 'active' },
        { $set: { status: 'replaced', replacedAt: now, replacedByDestinationId: destinationId } },
        { session: mongoSession }
      );
      await PaymentDestinationModel.create([{
        destinationId,
        recipientId: input.recipientId,
        ownerWalletId,
        rail: input.rail,
        network: input.network,
        assetId: input.assetId,
        kind: input.kind,
        value,
        valueHash: hashPrivateValue(value),
        resolverEndpoint,
        configurationIdempotencyKey: input.idempotencyKey,
        configurationFingerprint: fingerprint,
        reusable: true,
        status: 'active',
        verificationMethod: 'owner_configured',
        verificationScope: 'delivery_instruction',
        verifiedAt: now
      }], { session: mongoSession });
      await SessionModel.updateOne(
        { publicId: input.sessionId, ownerWalletId },
        {
          $set: {
            ['recipientWallets.' + recipient.sessionRecipientIndex + '.destinationId']: destinationId,
            ['recipientWallets.' + recipient.sessionRecipientIndex + '.destinationReusable']: true
          }
        },
        { session: mongoSession }
      );
      await PaymentScheduleModel.updateMany(
        {
          ownerWalletId,
          sessionId: input.sessionId,
          recipientId: input.recipientId,
          status: { $in: ['active', 'paused'] },
          rail: input.rail,
          network: input.network,
          assetId: input.assetId
        },
        { $set: { destinationId } },
        { session: mongoSession }
      );
      await PaymentScheduleModel.updateMany(
        {
          ownerWalletId,
          sessionId: input.sessionId,
          recipientId: input.recipientId,
          status: 'active',
          $or: [{ rail: { $ne: input.rail } }, { network: { $ne: input.network } }, { assetId: { $ne: input.assetId } }]
        },
        {
          $set: {
            status: 'paused',
            pausedAt: now,
            failureCode: 'DESTINATION_REPLACED_INCOMPATIBLE',
            failureMessage: 'Recipient destination changed to an incompatible payment capability.'
          }
        },
        { session: mongoSession }
      );
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const raced = await PaymentDestinationModel.findOne({ ownerWalletId, configurationIdempotencyKey: input.idempotencyKey }).lean<PaymentDestinationRecord | null>();
    if (!raced || raced.configurationFingerprint !== fingerprint) {
      throw new ApiError(409, 'DESTINATION_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for another destination configuration.');
    }
    return configuredDestinationDto(raced);
  }
  await writeAuditLog({
    actorWalletId: ownerWalletId,
    action: 'schedule.destination.configured',
    targetType: 'payment_destination',
    targetId: destinationId,
    metadata: { sessionId: input.sessionId, recipientId: input.recipientId, rail: input.rail, network: input.network, assetId: input.assetId, kind: input.kind }
  });
  return { destinationId, recipientId: input.recipientId, kind: input.kind, rail: input.rail, network: input.network, assetId: input.assetId, reusable: true };
}

function sessionAtomicFields(session: SessionRecord): { limit: string; spent: string; reserved: string } {
  return {
    limit: session.limitAtomic ?? legacyMinorToAtomicAmount(fallbackMinorUnits(session.limitMinor, session.limit, session.currency)),
    spent: session.spentAtomic ?? legacyMinorToAtomicAmount(fallbackMinorUnits(session.spentMinor, session.spent, session.currency)),
    reserved: session.reservedAtomic ?? legacyMinorToAtomicAmount(session.reservedMinor ?? 0)
  };
}

async function validateExecutor(input: CreatePaymentScheduleInput, ownerWalletId: string, sessionId: string): Promise<void> {
  if (input.rail === 'lightning' && input.executor === 'nwc') {
    const connection = await NwcConnectionModel.findOne({ connectionId: input.connectionId, ownerWalletId, status: 'active' }).lean();
    if (!connection || connection.network !== input.network || !(
      (connection.scopeType === 'wallet' && connection.scopeId === ownerWalletId)
      || (connection.scopeType === 'pass' && connection.scopeId === sessionId)
    )) throw new ApiError(404, 'NWC_CONNECTION_NOT_FOUND', 'Eligible NWC connection was not found for this pass.');
    if (
      connection.executionMode !== 'unattended'
      || !connection.allowanceEnforced
      || !connection.methods.includes('pay_invoice')
      || !connection.methods.includes('lookup_invoice')
    ) {
      throw new ApiError(409, 'NWC_UNATTENDED_POLICY_REQUIRED', 'Scheduled NWC execution requires a wallet-enforced unattended allowance and payment lookup.');
    }
    const remaining = parseAtomicAmount(connection.allowanceAtomic) - parseAtomicAmount(connection.allowanceUsedAtomic);
    if (remaining < parseAtomicAmount(input.amountAtomic)) throw new ApiError(409, 'NWC_ALLOWANCE_INSUFFICIENT', 'NWC wallet allowance is below one scheduled occurrence.');
    return;
  }
  if (input.rail === 'lightning' && input.executor === 'btcpay') {
    const connection = await BtcpayConnectionModel.findOne({ connectionId: input.connectionId, ownerWalletId, status: 'active' }).lean();
    if (!connection || connection.network !== input.network || !(
      (connection.scopeType === 'wallet' && connection.scopeId === ownerWalletId)
      || (connection.scopeType === 'pass' && connection.scopeId === sessionId)
    )) throw new ApiError(404, 'BTCPAY_CONNECTION_NOT_FOUND', 'Eligible BTCPay connection was not found for this pass.');
    return;
  }
  if (input.rail === 'fiber' && input.executor === 'fiber' && !input.connectionId) return;
  throw new ApiError(400, 'SCHEDULE_EXECUTOR_MISMATCH', 'Schedule executor does not support the selected rail.');
}

export async function createPaymentSchedule(
  sessionId: string,
  input: CreatePaymentScheduleInput,
  ownerWalletId: string
): Promise<PaymentScheduleDto> {
  const amountAtomic = asAtomicAmount(input.amountAtomic);
  const maxFeeAtomic = asAtomicAmount(input.maxFeeAtomic ?? '0');
  if (parseAtomicAmount(amountAtomic) <= 0n) throw new ApiError(400, 'SCHEDULE_AMOUNT_INVALID', 'Scheduled amount must be positive.');
  const timeZone = assertTimeZone(input.timeZone);
  if (!Number.isFinite(input.firstOccurrenceAt.getTime())) throw new ApiError(400, 'SCHEDULE_START_INVALID', 'First occurrence time is invalid.');
  if (input.cadence === 'custom' && (!Number.isSafeInteger(input.customIntervalSeconds) || (input.customIntervalSeconds ?? 0) < 1)) {
    throw new ApiError(400, 'SCHEDULE_INTERVAL_INVALID', 'Custom schedules require a positive interval in seconds.');
  }
  if (input.cadence !== 'custom' && input.customIntervalSeconds != null) {
    throw new ApiError(400, 'SCHEDULE_INTERVAL_UNEXPECTED', 'Custom interval is only valid for custom cadence.');
  }
  if (input.cadence === 'once' && input.occurrenceLimit != null && input.occurrenceLimit !== 1) {
    throw new ApiError(400, 'SCHEDULE_OCCURRENCE_LIMIT_INVALID', 'One-time schedules can execute exactly one occurrence.');
  }
  const fingerprint = requestFingerprint({
    destinationId: input.destinationId,
    rail: input.rail,
    network: input.network,
    assetId: input.assetId,
    amountAtomic,
    maxFeeAtomic,
    executor: input.executor,
    connectionId: input.connectionId,
    cadence: input.cadence,
    timeZone,
    firstOccurrenceAt: input.firstOccurrenceAt.toISOString(),
    customIntervalSeconds: input.customIntervalSeconds,
    occurrenceLimit: input.cadence === 'once' ? 1 : input.occurrenceLimit
  });
  const replay = await PaymentScheduleModel.findOne({ ownerWalletId, sessionId, idempotencyKey: input.idempotencyKey }).lean<PaymentScheduleRecord | null>();
  if (replay) {
    if (replay.requestFingerprint !== fingerprint) {
      throw new ApiError(409, 'SCHEDULE_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for another schedule configuration.');
    }
    return scheduleDto(replay);
  }

  const [session, destination] = await Promise.all([
    SessionModel.findOne({ publicId: sessionId, ownerWalletId }).lean<SessionRecord | null>(),
    PaymentDestinationModel.findOne({ destinationId: input.destinationId, ownerWalletId, status: 'active' }).lean<PaymentDestinationRecord | null>()
  ]);
  if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Pass was not found.');
  if (session.status !== 'active') throw new ApiError(409, 'SESSION_INACTIVE', 'Only an active pass can create a schedule.');
  if (input.rail === 'lightning' && (
    session.fundingMode !== 'connected_wallet'
    || session.fundingExecutionReady !== true
  )) {
    throw new ApiError(409, 'SCHEDULE_CONNECTED_WALLET_REQUIRED', 'Lightning schedules require an execution-ready connected-wallet pass.');
  }
  if (input.executor !== 'btcpay' && parseAtomicAmount(maxFeeAtomic) > 0n) {
    throw new ApiError(400, 'SCHEDULE_FEE_CAP_UNSUPPORTED', 'Only the BTCPay scheduled executor currently enforces a maximum fee.');
  }
  if (session.expiryAt && new Date(session.expiryAt).getTime() <= input.firstOccurrenceAt.getTime()) {
    throw new ApiError(400, 'SCHEDULE_AFTER_PASS_EXPIRY', 'First occurrence must be before pass expiry.');
  }
  if (!destination || !destination.reusable) throw new ApiError(404, 'REUSABLE_DESTINATION_NOT_FOUND', 'Active reusable destination was not found.');
  const recipient = await RecipientIdentityModel.findOne({
    recipientId: destination.recipientId,
    ownerWalletId,
    sessionId
  }).lean();
  if (!recipient) throw new ApiError(400, 'SCHEDULE_RECIPIENT_MISMATCH', 'Destination recipient does not belong to this pass.');
  if (
    destination.rail !== input.rail
    || destination.network.toLowerCase() !== input.network.toLowerCase()
    || destination.assetId !== input.assetId
  ) throw new ApiError(400, 'SCHEDULE_DESTINATION_MISMATCH', 'Destination rail, network, or asset does not match the schedule.');
  const sessionAssetId = session.assetId ?? assetIdForLegacyCurrency(session.currency);
  if (sessionAssetId !== input.assetId) throw new ApiError(400, 'SCHEDULE_ASSET_MISMATCH', 'Schedule asset does not match the pass.');
  const money = sessionAtomicFields(session);
  if (parseAtomicAmount(amountAtomic) > parseAtomicAmount(money.limit) - parseAtomicAmount(money.spent) - parseAtomicAmount(money.reserved)) {
    throw new ApiError(409, 'SCHEDULE_PASS_DEPLETED', 'Pass cannot fund one scheduled occurrence.');
  }
  await validateExecutor(input, ownerWalletId, sessionId);

  const scheduleId = 'sch_' + randomUUID();
  let created: PaymentScheduleRecord & { createdAt?: Date };
  try {
    const document = await PaymentScheduleModel.create({
      scheduleId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      sessionId,
      ownerWalletId,
      recipientId: destination.recipientId,
      destinationId: destination.destinationId,
      rail: input.rail,
      network: input.network,
      assetId: input.assetId,
      moneyContractVersion: 2,
      amountAtomic,
      maxFeeAtomic,
      spentAtomic: '0',
      executor: input.executor,
      connectionId: input.connectionId,
      cadence: input.cadence,
      timeZone,
      anchorDay: input.cadence === 'monthly' ? occurrenceLocalDay(input.firstOccurrenceAt, timeZone) : undefined,
      customIntervalSeconds: input.customIntervalSeconds,
      status: 'active',
      nextOccurrenceAt: input.firstOccurrenceAt,
      occurrenceLimit: input.cadence === 'once' ? 1 : input.occurrenceLimit,
      occurrenceCount: 0
    });
    created = document.toObject();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const raced = await PaymentScheduleModel.findOne({ ownerWalletId, sessionId, idempotencyKey: input.idempotencyKey }).lean<PaymentScheduleRecord | null>();
    if (!raced || raced.requestFingerprint !== fingerprint) {
      throw new ApiError(409, 'SCHEDULE_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for another schedule configuration.');
    }
    return scheduleDto(raced);
  }
  await writeAuditLog({
    actorWalletId: ownerWalletId,
    action: 'schedule.created',
    targetType: 'payment_schedule',
    targetId: scheduleId,
    metadata: { sessionId, recipientId: destination.recipientId, destinationId: destination.destinationId, rail: input.rail, network: input.network, assetId: input.assetId, amountAtomic, cadence: input.cadence, executor: input.executor }
  });
  return scheduleDto(created);
}

export async function listPaymentSchedules(sessionId: string, ownerWalletId: string): Promise<{
  schedules: PaymentScheduleDto[];
  occurrences: PaymentOccurrenceDto[];
}> {
  if (!await SessionModel.exists({ publicId: sessionId, ownerWalletId })) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Pass was not found.');
  const schedules = await PaymentScheduleModel.find({ sessionId, ownerWalletId }).sort({ createdAt: 1 }).lean<PaymentScheduleRecord[]>();
  const occurrences = schedules.length === 0 ? [] : await ScheduledOccurrenceModel.find({
    scheduleId: { $in: schedules.map((schedule) => schedule.scheduleId) }
  }).sort({ dueAt: -1 }).limit(100).lean<ScheduledOccurrenceRecord[]>();
  return { schedules: schedules.map(scheduleDto), occurrences: occurrences.map(occurrenceDto) };
}

export async function controlPaymentSchedule(
  scheduleId: string,
  ownerWalletId: string,
  action: 'pause' | 'resume' | 'revoke'
): Promise<PaymentScheduleDto> {
  const schedule = await PaymentScheduleModel.findOne({ scheduleId, ownerWalletId });
  if (!schedule) throw new ApiError(404, 'SCHEDULE_NOT_FOUND', 'Payment schedule was not found.');
  const now = new Date();
  if (action === 'pause') {
    if (schedule.status === 'paused') return scheduleDto(schedule.toObject());
    if (schedule.status !== 'active') throw new ApiError(409, 'SCHEDULE_NOT_ACTIVE', 'Only an active schedule can be paused.');
    schedule.status = 'paused';
    schedule.pausedAt = now;
  } else if (action === 'resume') {
    if (schedule.status === 'active') return scheduleDto(schedule.toObject());
    if (schedule.status !== 'paused') throw new ApiError(409, 'SCHEDULE_NOT_PAUSED', 'Only a paused schedule can be resumed.');
    const session = await SessionModel.findOne({ publicId: schedule.sessionId, ownerWalletId }).lean<SessionRecord | null>();
    if (!session || session.status !== 'active' || (session.expiryAt && new Date(session.expiryAt).getTime() <= now.getTime())) {
      throw new ApiError(409, 'SESSION_INACTIVE', 'Pass must be active and unexpired before resuming a schedule.');
    }
    schedule.status = 'active';
    schedule.pausedAt = undefined;
    schedule.failureCode = undefined;
    schedule.failureMessage = undefined;
  } else {
    if (schedule.status === 'revoked') return scheduleDto(schedule.toObject());
    if (['completed', 'revoked', 'depleted', 'expired'].includes(schedule.status)) {
      throw new ApiError(409, 'SCHEDULE_TERMINAL', 'Payment schedule is already terminal.');
    }
    schedule.status = 'revoked';
    schedule.revokedAt = now;
  }
  await schedule.save();
  if (action === 'revoke') {
    const releasable = await ScheduledOccurrenceModel.find({
      scheduleId,
      status: { $in: ['resolving', 'retrying'] },
      submittedAt: { $exists: false }
    }).lean<ScheduledOccurrenceRecord[]>();
    for (const occurrence of releasable) {
      await blockOccurrence(occurrence, new ApiError(409, 'SCHEDULE_REVOKED', 'Schedule was revoked before this occurrence was submitted.'), now);
    }
  }
  await writeAuditLog({ actorWalletId: ownerWalletId, action: 'schedule.' + action, targetType: 'payment_schedule', targetId: scheduleId });
  return scheduleDto(schedule.toObject());
}

function setAtomicCompatibility(document: {
  set(path: string, value: unknown): void;
}, field: 'spent' | 'reserved' | 'limit', value: bigint): void {
  document.set(field + 'Atomic', atomicAmountFromBigInt(value));
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    document.set(field + 'Minor', Number(value));
  }
}

async function reserveOccurrenceBudget(
  occurrenceId: string,
  now: Date
): Promise<'reserved' | 'depleted' | 'inactive'> {
  let result: 'reserved' | 'depleted' | 'inactive' = 'inactive';
  await SessionModel.db.transaction(async (mongoSession) => {
    const occurrence = await ScheduledOccurrenceModel.findOne({ occurrenceId }).session(mongoSession);
    if (!occurrence) return;
    if (occurrence.reservationState === 'reserved' || occurrence.reservationState === 'spent') {
      result = 'reserved';
      return;
    }
    const session = await SessionModel.findOne({ publicId: occurrence.sessionId }).session(mongoSession);
    if (!session || session.status !== 'active' || (session.expiryAt && session.expiryAt.getTime() <= now.getTime())) return;
    const exact = sessionAtomicFields(session.toObject() as SessionRecord);
    const limit = parseAtomicAmount(exact.limit);
    const spent = parseAtomicAmount(exact.spent);
    const reserved = parseAtomicAmount(exact.reserved);
    const amount = parseAtomicAmount(occurrence.amountAtomic);
    if (spent + reserved + amount > limit) {
      result = 'depleted';
      return;
    }
    setAtomicCompatibility(session, 'limit', limit);
    setAtomicCompatibility(session, 'spent', spent);
    setAtomicCompatibility(session, 'reserved', reserved + amount);
    occurrence.reservationState = 'reserved';
    occurrence.reservedAt = now;
    await session.save({ session: mongoSession });
    await occurrence.save({ session: mongoSession });
    result = 'reserved';
  });
  return result;
}

async function releaseOccurrenceBudget(occurrenceId: string, mongoSession: ClientSession): Promise<void> {
  const occurrence = await ScheduledOccurrenceModel.findOne({ occurrenceId }).session(mongoSession);
  if (!occurrence || occurrence.reservationState !== 'reserved') return;
  const session = await SessionModel.findOne({ publicId: occurrence.sessionId }).session(mongoSession);
  if (session) {
    const exact = sessionAtomicFields(session.toObject() as SessionRecord);
    const reserved = parseAtomicAmount(exact.reserved);
    const amount = parseAtomicAmount(occurrence.amountAtomic);
    setAtomicCompatibility(session, 'reserved', reserved >= amount ? reserved - amount : 0n);
    await session.save({ session: mongoSession });
  }
  occurrence.reservationState = 'released';
  await occurrence.save({ session: mongoSession });
}

async function claimOccurrence(
  schedule: PaymentScheduleRecord,
  now: Date,
  workerId: string
): Promise<ScheduledOccurrenceRecord | null> {
  const occurrenceId = stableOccurrenceId(schedule.scheduleId, schedule.nextOccurrenceAt);
  const leaseId = workerId + ':' + randomUUID();
  try {
    const created = await ScheduledOccurrenceModel.create({
      occurrenceId,
      scheduleId: schedule.scheduleId,
      sessionId: schedule.sessionId,
      ownerWalletId: schedule.ownerWalletId,
      recipientId: schedule.recipientId,
      destinationId: schedule.destinationId,
      dueAt: schedule.nextOccurrenceAt,
      rail: schedule.rail,
      network: schedule.network,
      assetId: schedule.assetId,
      moneyContractVersion: 2,
      amountAtomic: schedule.amountAtomic,
      status: 'resolving',
      reservationState: 'none',
      executionLeaseId: leaseId,
      executionLeaseExpiresAt: new Date(now.getTime() + OCCURRENCE_LEASE_MS),
      retryCount: 0
    });
    return created.toObject();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  const claimed = await ScheduledOccurrenceModel.findOneAndUpdate(
    {
      occurrenceId,
      status: { $in: ['resolving', 'executing', 'uncertain', 'retrying'] },
      $and: [
        { $or: [{ executionLeaseExpiresAt: { $lte: now } }, { executionLeaseExpiresAt: { $exists: false } }] },
        { $or: [{ nextAttemptAt: { $lte: now } }, { nextAttemptAt: { $exists: false } }] }
      ]
    },
    {
      $set: {
        executionLeaseId: leaseId,
        executionLeaseExpiresAt: new Date(now.getTime() + OCCURRENCE_LEASE_MS)
      }
    },
    { new: true }
  ).lean<ScheduledOccurrenceRecord | null>();
  return claimed;
}

async function claimInFlightOccurrence(
  occurrenceId: string,
  now: Date,
  workerId: string
): Promise<ScheduledOccurrenceRecord | null> {
  const leaseId = workerId + ':' + randomUUID();
  return ScheduledOccurrenceModel.findOneAndUpdate(
    {
      occurrenceId,
      status: { $in: ['executing', 'uncertain'] },
      $and: [
        { $or: [{ executionLeaseExpiresAt: { $lte: now } }, { executionLeaseExpiresAt: { $exists: false } }] },
        { $or: [{ nextAttemptAt: { $lte: now } }, { nextAttemptAt: { $exists: false } }] }
      ]
    },
    {
      $set: {
        executionLeaseId: leaseId,
        executionLeaseExpiresAt: new Date(now.getTime() + OCCURRENCE_LEASE_MS)
      }
    },
    { new: true }
  ).lean<ScheduledOccurrenceRecord | null>();
}

async function markOccurrenceRetry(
  occurrence: ScheduledOccurrenceRecord,
  error: unknown,
  now: Date,
  status: 'retrying' | 'uncertain' = 'retrying'
): Promise<void> {
  const retryCount = occurrence.retryCount + 1;
  const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(retryCount - 1, 7), 60 * 60 * 1000);
  const code = error instanceof ApiError ? error.code : 'DESTINATION_RESOLVER_FAILED';
  await ScheduledOccurrenceModel.updateOne(
    { occurrenceId: occurrence.occurrenceId, executionLeaseId: occurrence.executionLeaseId },
    {
      $set: {
        status,
        retryCount,
        nextAttemptAt: new Date(now.getTime() + delay),
        failureCode: code,
        failureMessage: error instanceof ApiError ? error.message : 'Scheduled payment resolver or executor is temporarily unavailable.',
        executionLeaseExpiresAt: now
      },
      $unset: { executionLeaseId: 1 }
    }
  );
}

async function blockOccurrence(occurrence: ScheduledOccurrenceRecord, error: unknown, now: Date): Promise<void> {
  const code = error instanceof ApiError ? error.code : 'SCHEDULE_EXECUTION_BLOCKED';
  const message = error instanceof ApiError ? error.message : 'Scheduled payment could not be validated.';
  await ScheduledOccurrenceModel.db.transaction(async (mongoSession) => {
    await releaseOccurrenceBudget(occurrence.occurrenceId, mongoSession);
    await ScheduledOccurrenceModel.updateOne(
      { occurrenceId: occurrence.occurrenceId },
      {
        $set: { status: 'blocked', failureCode: code, failureMessage: message, completedAt: now, executionLeaseExpiresAt: now },
        $unset: { executionLeaseId: 1 }
      },
      { session: mongoSession }
    );
    await PaymentScheduleModel.updateOne(
      { scheduleId: occurrence.scheduleId, status: 'active' },
      { $set: { status: 'paused', pausedAt: now, failureCode: code, failureMessage: message } },
      { session: mongoSession }
    );
  });
}

async function closeScheduleForPassState(
  schedule: PaymentScheduleRecord,
  status: 'completed' | 'revoked' | 'expired',
  now: Date,
  code: string,
  message: string
): Promise<void> {
  const occurrence = await ScheduledOccurrenceModel.findOne({
    occurrenceId: stableOccurrenceId(schedule.scheduleId, schedule.nextOccurrenceAt),
    status: { $in: ['resolving', 'retrying'] },
    submittedAt: { $exists: false }
  }).lean<ScheduledOccurrenceRecord | null>();
  if (occurrence) await blockOccurrence(occurrence, new ApiError(409, code, message), now);
  await PaymentScheduleModel.updateOne(
    { scheduleId: schedule.scheduleId, status: { $in: ['active', 'paused'] } },
    { $set: { status, completedAt: now, failureCode: code, failureMessage: message } }
  );
}

function retryableError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.statusCode >= 500
    || error.code.endsWith('_EXPIRED')
    || error.code === 'PAYMENT_REQUEST_REUSED'
    || error.code.includes('UNAVAILABLE')
    || error.code.includes('TIMEOUT');
}

async function finalizeOccurrenceSuccess(input: {
  occurrence: ScheduledOccurrenceRecord;
  executorPaymentId: string;
  paymentHash?: string;
  proofKind?: string;
  proofReference?: string;
  sessionAlreadyDebited?: boolean;
  now: Date;
}): Promise<void> {
  await ScheduledOccurrenceModel.db.transaction(async (mongoSession) => {
    const occurrence = await ScheduledOccurrenceModel.findOne({ occurrenceId: input.occurrence.occurrenceId }).session(mongoSession);
    if (!occurrence || occurrence.status === 'succeeded') return;
    const schedule = await PaymentScheduleModel.findOne({ scheduleId: occurrence.scheduleId }).session(mongoSession);
    const session = await SessionModel.findOne({ publicId: occurrence.sessionId }).session(mongoSession);
    if (!schedule || !session) throw new ApiError(503, 'SCHEDULE_STATE_MISSING', 'Scheduled payment state is incomplete.');
    const amount = parseAtomicAmount(occurrence.amountAtomic);
    const exact = sessionAtomicFields(session.toObject() as SessionRecord);
    let spent = parseAtomicAmount(exact.spent);
    let reserved = parseAtomicAmount(exact.reserved);
    if (!input.sessionAlreadyDebited) {
      if (occurrence.reservationState !== 'reserved' || reserved < amount) {
        throw new ApiError(503, 'SCHEDULE_RESERVATION_MISSING', 'Scheduled payment reservation is missing.');
      }
      reserved -= amount;
      spent += amount;
      setAtomicCompatibility(session, 'reserved', reserved);
      setAtomicCompatibility(session, 'spent', spent);
      occurrence.reservationState = 'spent';
      await session.save({ session: mongoSession });
    }
    occurrence.status = 'succeeded';
    occurrence.executorPaymentId = input.executorPaymentId;
    occurrence.paymentHash = input.paymentHash;
    occurrence.proofKind = input.proofKind;
    occurrence.proofReference = input.proofReference;
    occurrence.completedAt = input.now;
    occurrence.executionLeaseExpiresAt = input.now;
    occurrence.executionLeaseId = undefined;
    occurrence.failureCode = undefined;
    occurrence.failureMessage = undefined;
    await occurrence.save({ session: mongoSession });

    const nextCount = schedule.occurrenceCount + 1;
    const nextSpent = parseAtomicAmount(schedule.spentAtomic) + amount;
    schedule.occurrenceCount = nextCount;
    schedule.spentAtomic = atomicAmountFromBigInt(nextSpent);
    schedule.lastOccurrenceAt = occurrence.dueAt;
    schedule.failureCode = undefined;
    schedule.failureMessage = undefined;
    const next = nextOccurrenceAfter(occurrence.dueAt, {
      cadence: schedule.cadence,
      timeZone: schedule.timeZone,
      anchorDay: schedule.anchorDay ?? undefined,
      customIntervalSeconds: schedule.customIntervalSeconds ?? undefined
    });
    const passExact = sessionAtomicFields(session.toObject() as SessionRecord);
    const depleted = parseAtomicAmount(passExact.spent) + parseAtomicAmount(passExact.reserved) + amount > parseAtomicAmount(passExact.limit);
    const limitReached = schedule.occurrenceLimit != null && nextCount >= schedule.occurrenceLimit;
    const passExpiry = session.expiryAt;
    if (depleted) schedule.status = 'depleted';
    else if (!next || limitReached) schedule.status = 'completed';
    else if (passExpiry && next.getTime() >= passExpiry.getTime()) schedule.status = 'expired';
    else schedule.nextOccurrenceAt = next;
    if (['completed', 'revoked', 'depleted', 'expired'].includes(schedule.status)) schedule.completedAt = input.now;
    await schedule.save({ session: mongoSession });
  });
  await writeAuditLog({
    actorWalletId: input.occurrence.ownerWalletId,
    action: 'schedule.occurrence.succeeded',
    targetType: 'scheduled_occurrence',
    targetId: input.occurrence.occurrenceId,
    metadata: { scheduleId: input.occurrence.scheduleId, amountAtomic: input.occurrence.amountAtomic, paymentHash: input.paymentHash, executorPaymentId: input.executorPaymentId }
  });
}

async function reconcileExistingExecution(
  schedule: PaymentScheduleRecord,
  occurrence: ScheduledOccurrenceRecord,
  now: Date
): Promise<'none' | 'pending' | 'succeeded' | 'failed'> {
  if (schedule.executor === 'nwc') {
    const stored = await NwcPaymentModel.findOne({
      ownerWalletId: schedule.ownerWalletId,
      connectionId: schedule.connectionId,
      idempotencyKey: occurrence.occurrenceId
    }).lean();
    if (!stored) return 'none';
    const payment = await getNwcPaymentStatus({ connectionId: stored.connectionId, ownerWalletId: stored.ownerWalletId, paymentHash: stored.paymentHash });
    if (payment.status === 'succeeded') {
      await finalizeOccurrenceSuccess({ occurrence, executorPaymentId: payment.id, paymentHash: payment.paymentHash, proofKind: payment.proof?.kind, proofReference: payment.proof?.reference, now });
      return 'succeeded';
    }
    if (payment.status === 'failed') return 'failed';
    await ScheduledOccurrenceModel.updateOne({ occurrenceId: occurrence.occurrenceId }, {
      $set: { status: 'uncertain', executorPaymentId: payment.id, paymentHash: payment.paymentHash, reconciledAt: now, executionLeaseExpiresAt: now },
      $unset: { executionLeaseId: 1 }
    });
    return 'pending';
  }
  if (schedule.executor === 'btcpay') {
    const stored = await BtcpayPaymentModel.findOne({
      ownerWalletId: schedule.ownerWalletId,
      connectionId: schedule.connectionId,
      idempotencyKey: occurrence.occurrenceId
    }).lean();
    if (!stored) return 'none';
    const payment = await getBtcpayPayment({ connectionId: stored.connectionId, ownerWalletId: stored.ownerWalletId, paymentHash: stored.paymentHash });
    if (payment.status === 'succeeded') {
      await finalizeOccurrenceSuccess({ occurrence, executorPaymentId: payment.id, paymentHash: payment.paymentHash, proofKind: payment.proof?.kind, proofReference: payment.proof?.reference, now });
      return 'succeeded';
    }
    if (payment.status === 'failed') return 'failed';
    await ScheduledOccurrenceModel.updateOne({ occurrenceId: occurrence.occurrenceId }, {
      $set: { status: 'uncertain', executorPaymentId: payment.id, paymentHash: payment.paymentHash, reconciledAt: now, executionLeaseExpiresAt: now },
      $unset: { executionLeaseId: 1 }
    });
    return 'pending';
  }
  const attempt = await ChargeAttemptModel.findOne({ sessionId: schedule.sessionId, idempotencyKey: occurrence.occurrenceId }).lean();
  if (!attempt) return 'none';
  if (attempt.status === 'succeeded') {
    await finalizeOccurrenceSuccess({ occurrence, executorPaymentId: attempt.attemptId, proofKind: attempt.proofType ?? undefined, proofReference: attempt.proofId ?? undefined, sessionAlreadyDebited: true, now });
    return 'succeeded';
  }
  if (attempt.status === 'failed') return 'failed';
  await ScheduledOccurrenceModel.updateOne({ occurrenceId: occurrence.occurrenceId }, {
    $set: { status: 'uncertain', executorPaymentId: attempt.attemptId, reconciledAt: now, executionLeaseExpiresAt: now },
    $unset: { executionLeaseId: 1 }
  });
  return 'pending';
}

async function executeResolvedRequest(
  schedule: PaymentScheduleRecord,
  occurrence: ScheduledOccurrenceRecord,
  paymentRequest: string,
  paymentHash: string | undefined,
  now: Date
): Promise<'succeeded' | 'pending'> {
  await ScheduledOccurrenceModel.updateOne(
    { occurrenceId: occurrence.occurrenceId, executionLeaseId: occurrence.executionLeaseId },
    { $set: { status: 'executing', submittedAt: now } }
  );
  if (schedule.executor === 'nwc') {
    const payment = await payNwcInvoice({
      connectionId: schedule.connectionId ?? '',
      ownerWalletId: schedule.ownerWalletId,
      invoice: paymentRequest,
      idempotencyKey: occurrence.occurrenceId,
      executionMode: 'unattended'
    });
    if (payment.status === 'succeeded') {
      await finalizeOccurrenceSuccess({ occurrence, executorPaymentId: payment.id, paymentHash: payment.paymentHash, proofKind: payment.proof?.kind, proofReference: payment.proof?.reference, now: new Date() });
      return 'succeeded';
    }
    await ScheduledOccurrenceModel.updateOne({ occurrenceId: occurrence.occurrenceId }, {
      $set: { status: 'uncertain', executorPaymentId: payment.id, paymentHash: payment.paymentHash, executionLeaseExpiresAt: new Date() },
      $unset: { executionLeaseId: 1 }
    });
    return 'pending';
  }
  if (schedule.executor === 'btcpay') {
    const payment = await payBtcpayLightning({ connectionId: schedule.connectionId ?? '', ownerWalletId: schedule.ownerWalletId, invoice: paymentRequest, idempotencyKey: occurrence.occurrenceId, maxFeeAtomic: schedule.maxFeeAtomic });
    if (payment.status === 'succeeded') {
      await finalizeOccurrenceSuccess({ occurrence, executorPaymentId: payment.id, paymentHash: payment.paymentHash, proofKind: payment.proof?.kind, proofReference: payment.proof?.reference, now: new Date() });
      return 'succeeded';
    }
    await ScheduledOccurrenceModel.updateOne({ occurrenceId: occurrence.occurrenceId }, {
      $set: { status: 'uncertain', executorPaymentId: payment.id, paymentHash: payment.paymentHash, executionLeaseExpiresAt: new Date() },
      $unset: { executionLeaseId: 1 }
    });
    return 'pending';
  }
  const amount = formatAtomicAmount(asAtomicAmount(schedule.amountAtomic), getCurrencyMetadata('CKB').decimals);
  await chargeSession({
    sessionId: schedule.sessionId,
    amount: Number(amount),
    type: 'Scheduled payment occurrence',
    paymentRequest,
    idempotencyKey: occurrence.occurrenceId,
    metadata: {
      scheduledPayout: true,
      payoutRail: 'fiber',
      recipientId: schedule.recipientId,
      destinationId: schedule.destinationId,
      occurrenceId: occurrence.occurrenceId,
      paymentRequestHash: occurrence.paymentRequestHash
    }
  });
  const attempt = await ChargeAttemptModel.findOne({ sessionId: schedule.sessionId, idempotencyKey: occurrence.occurrenceId }).lean();
  if (!attempt || attempt.status !== 'succeeded') {
    await ScheduledOccurrenceModel.updateOne({ occurrenceId: occurrence.occurrenceId }, {
      $set: { status: 'uncertain', executorPaymentId: attempt?.attemptId, paymentHash, executionLeaseExpiresAt: new Date() },
      $unset: { executionLeaseId: 1 }
    });
    return 'pending';
  }
  await finalizeOccurrenceSuccess({ occurrence, executorPaymentId: attempt.attemptId, proofKind: attempt.proofType ?? undefined, proofReference: attempt.proofId ?? undefined, sessionAlreadyDebited: true, now: new Date() });
  return 'succeeded';
}

export interface ScheduledPaymentWorkerResult {
  scanned: number;
  claimed: number;
  succeeded: number;
  pending: number;
  retrying: number;
  blocked: number;
  skipped: number;
}

export async function runDuePaymentSchedules(input: {
  ownerWalletId?: string;
  limit?: number;
  workerId?: string;
  now?: Date;
  resolverTransport?: ResolverTransport;
} = {}): Promise<ScheduledPaymentWorkerResult> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  const result: ScheduledPaymentWorkerResult = { scanned: 0, claimed: 0, succeeded: 0, pending: 0, retrying: 0, blocked: 0, skipped: 0 };
  const workerId = input.workerId ?? 'scheduled-payment-worker';
  const handledScheduleIds = new Set<string>();
  const inFlightQuery: Record<string, unknown> = {
    status: { $in: ['executing', 'uncertain'] },
    $and: [
      { $or: [{ executionLeaseExpiresAt: { $lte: now } }, { executionLeaseExpiresAt: { $exists: false } }] },
      { $or: [{ nextAttemptAt: { $lte: now } }, { nextAttemptAt: { $exists: false } }] }
    ]
  };
  if (input.ownerWalletId) inFlightQuery.ownerWalletId = input.ownerWalletId;
  const inFlight = await ScheduledOccurrenceModel.find(inFlightQuery).sort({ dueAt: 1 }).limit(limit).lean<ScheduledOccurrenceRecord[]>();
  result.scanned += inFlight.length;
  for (const candidate of inFlight) {
    const schedule = await PaymentScheduleModel.findOne({ scheduleId: candidate.scheduleId }).lean<PaymentScheduleRecord | null>();
    if (!schedule) {
      result.skipped += 1;
      continue;
    }
    const occurrence = await claimInFlightOccurrence(candidate.occurrenceId, now, workerId);
    if (!occurrence) {
      result.skipped += 1;
      continue;
    }
    handledScheduleIds.add(schedule.scheduleId);
    result.claimed += 1;
    try {
      const recovered = await reconcileExistingExecution(schedule, occurrence, now);
      if (recovered === 'succeeded') result.succeeded += 1;
      else if (recovered === 'pending') result.pending += 1;
      else if (recovered === 'failed') {
        await blockOccurrence(occurrence, new ApiError(409, 'SCHEDULE_PAYMENT_FAILED', 'Executor reports that this occurrence failed.'), now);
        result.blocked += 1;
      } else if (schedule.status === 'revoked') {
        await blockOccurrence(occurrence, new ApiError(409, 'SCHEDULE_REVOKED', 'Revoked schedule has no submitted executor payment to reconcile.'), now);
        result.blocked += 1;
      } else {
        await markOccurrenceRetry(occurrence, new ApiError(503, 'SCHEDULE_EXECUTION_NOT_SUBMITTED', 'No executor payment exists; resolve a fresh request before retry.'), now);
        result.retrying += 1;
      }
    } catch (error) {
      await markOccurrenceRetry(occurrence, error, now, 'uncertain');
      result.retrying += 1;
    }
  }

  const query: Record<string, unknown> = {
    status: 'active',
    nextOccurrenceAt: { $lte: now },
    ...(handledScheduleIds.size > 0 ? { scheduleId: { $nin: [...handledScheduleIds] } } : {})
  };
  if (input.ownerWalletId) query.ownerWalletId = input.ownerWalletId;
  const schedules = await PaymentScheduleModel.find(query).sort({ nextOccurrenceAt: 1, createdAt: 1 }).limit(limit).lean<PaymentScheduleRecord[]>();
  result.scanned += schedules.length;

  for (const schedule of schedules) {
    const session = await SessionModel.findOne({ publicId: schedule.sessionId, ownerWalletId: schedule.ownerWalletId }).lean<SessionRecord | null>();
    if (!session) {
      await closeScheduleForPassState(schedule, 'revoked', now, 'SCHEDULE_PASS_NOT_FOUND', 'Pass no longer exists for this schedule.');
      result.skipped += 1;
      continue;
    }
    if (session.status !== 'active') {
      if (session.status !== 'paused') {
        const terminalStatus = session.status === 'expired' ? 'expired' : session.status === 'settled' ? 'completed' : 'revoked';
        await closeScheduleForPassState(schedule, terminalStatus, now, 'SCHEDULE_PASS_INACTIVE', 'Pass state blocks all future scheduled occurrences.');
      }
      result.skipped += 1;
      continue;
    }
    if (session.expiryAt && new Date(session.expiryAt).getTime() <= now.getTime()) {
      await closeScheduleForPassState(schedule, 'expired', now, 'SCHEDULE_PASS_EXPIRED', 'Pass expired before this occurrence could be submitted.');
      result.skipped += 1;
      continue;
    }
    if (schedule.occurrenceLimit != null && schedule.occurrenceCount >= schedule.occurrenceLimit) {
      await PaymentScheduleModel.updateOne({ scheduleId: schedule.scheduleId, status: 'active' }, { $set: { status: 'completed', completedAt: now } });
      result.skipped += 1;
      continue;
    }
    const occurrence = await claimOccurrence(schedule, now, workerId);
    if (!occurrence) {
      result.skipped += 1;
      continue;
    }
    result.claimed += 1;

    try {
      const recovered = await reconcileExistingExecution(schedule, occurrence, now);
      if (recovered === 'succeeded') {
        result.succeeded += 1;
        continue;
      }
      if (recovered === 'pending') {
        result.pending += 1;
        continue;
      }
      if (recovered === 'failed') {
        await blockOccurrence(occurrence, new ApiError(409, 'SCHEDULE_PAYMENT_FAILED', 'Executor reports that this occurrence failed.'), now);
        result.blocked += 1;
        continue;
      }

      if (schedule.executor !== 'fiber') {
        const reservation = await reserveOccurrenceBudget(occurrence.occurrenceId, now);
        if (reservation === 'depleted') {
          await PaymentScheduleModel.updateOne({ scheduleId: schedule.scheduleId, status: 'active' }, { $set: { status: 'depleted', completedAt: now } });
          await ScheduledOccurrenceModel.updateOne({ occurrenceId: occurrence.occurrenceId }, { $set: { status: 'blocked', failureCode: 'SCHEDULE_PASS_DEPLETED', failureMessage: 'Pass cannot fund this occurrence.', completedAt: now } });
          result.blocked += 1;
          continue;
        }
        if (reservation === 'inactive') {
          result.skipped += 1;
          continue;
        }
      }

      const destination = await PaymentDestinationModel.findOne({
        destinationId: schedule.destinationId,
        recipientId: schedule.recipientId,
        ownerWalletId: schedule.ownerWalletId,
        status: 'active',
        reusable: true
      }).lean<PaymentDestinationRecord | null>();
      if (!destination) throw new ApiError(409, 'SCHEDULE_DESTINATION_INACTIVE', 'Scheduled destination is no longer active.');
      if (destination.rail !== schedule.rail || destination.network !== schedule.network || destination.assetId !== schedule.assetId) {
        throw new ApiError(409, 'SCHEDULE_DESTINATION_MISMATCH', 'Scheduled destination no longer matches the authorized payment contract.');
      }
      const resolved = await resolveFreshPaymentRequest({
        occurrenceId: occurrence.occurrenceId,
        dueAt: occurrence.dueAt,
        destination: {
          destinationId: destination.destinationId,
          recipientId: destination.recipientId,
          rail: destination.rail as PaymentRail,
          network: destination.network,
          assetId: destination.assetId,
          kind: destination.kind,
          value: destination.value,
          resolverEndpoint: destination.resolverEndpoint ?? undefined
        } satisfies ReusableDestinationInput,
        amountAtomic: occurrence.amountAtomic,
        now
      }, input.resolverTransport);
      try {
        const stored = await ScheduledOccurrenceModel.findOneAndUpdate(
          { occurrenceId: occurrence.occurrenceId, executionLeaseId: occurrence.executionLeaseId },
          {
            $set: {
              paymentRequestHash: resolved.paymentRequestHash,
              paymentHash: resolved.paymentHash,
              requestExpiresAt: resolved.expiresAt,
              resolvedAt: now,
              status: 'executing'
            },
            $unset: { failureCode: 1, failureMessage: 1, nextAttemptAt: 1 }
          },
          { new: true }
        ).lean<ScheduledOccurrenceRecord | null>();
        if (!stored) {
          result.skipped += 1;
          continue;
        }
      } catch (error) {
        if (isDuplicateKey(error)) throw new ApiError(409, 'PAYMENT_REQUEST_REUSED', 'Resolver returned a payment request already assigned to another occurrence.');
        throw error;
      }
      const execution = await executeResolvedRequest(schedule, { ...occurrence, paymentRequestHash: resolved.paymentRequestHash, paymentHash: resolved.paymentHash }, resolved.paymentRequest, resolved.paymentHash, now);
      result[execution] += 1;
    } catch (error) {
      if (retryableError(error)) {
        await markOccurrenceRetry(occurrence, error, now);
        result.retrying += 1;
      } else {
        await blockOccurrence(occurrence, error, now);
        result.blocked += 1;
      }
    }
  }
  return result;
}
