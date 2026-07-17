import type { AtomicAmount } from '../lib/money.js';
import { parseAtomicAmount } from '../lib/money.js';
import type { AssetId, PaymentRail } from './payment.js';

export const METERED_GRANT_STATUSES = ['active', 'revoked', 'expired', 'depleted'] as const;
export type MeteredGrantStatus = (typeof METERED_GRANT_STATUSES)[number];

export const USAGE_EVENT_STATUSES = ['reserved', 'settling', 'settled', 'released', 'failed'] as const;
export type UsageEventStatus = (typeof USAGE_EVENT_STATUSES)[number];

export const METERED_BATCH_STATUSES = [
  'collecting',
  'queued',
  'processing',
  'uncertain',
  'retrying',
  'succeeded',
  'failed',
  'released'
] as const;
export type MeteredBatchStatus = (typeof METERED_BATCH_STATUSES)[number];

export const METERED_EXECUTORS = ['nwc', 'btcpay', 'fiber'] as const;
export type MeteredExecutor = (typeof METERED_EXECUTORS)[number];

export interface MeteredBatchIdentity {
  ownerWalletId: string;
  appId: string;
  grantId: string;
  sessionId: string;
  recipientId: string;
  destinationId: string;
  rail: PaymentRail;
  network: string;
  assetId: AssetId;
  executor: MeteredExecutor;
  connectionId?: string;
}

export function meteredBatchKey(identity: MeteredBatchIdentity): string {
  return [
    identity.ownerWalletId,
    identity.appId,
    identity.grantId,
    identity.sessionId,
    identity.recipientId,
    identity.destinationId,
    identity.rail,
    identity.network.toLowerCase(),
    identity.assetId,
    identity.executor,
    identity.connectionId ?? ''
  ].join('\u001f');
}

export function assertMeteredGrantLimits(input: {
  maxPerEventAtomic: AtomicAmount;
  totalLimitAtomic: AtomicAmount;
  immediateThresholdAtomic: AtomicAmount;
  maxBatchAtomic: AtomicAmount;
}): void {
  const perEvent = parseAtomicAmount(input.maxPerEventAtomic);
  const total = parseAtomicAmount(input.totalLimitAtomic);
  const threshold = parseAtomicAmount(input.immediateThresholdAtomic);
  const maxBatch = parseAtomicAmount(input.maxBatchAtomic);
  if (perEvent <= 0n || total <= 0n || threshold <= 0n || maxBatch <= 0n) {
    throw new Error('Metered payment limits must be positive atomic amounts.');
  }
  if (perEvent > total) throw new Error('Per-event limit cannot exceed the grant total.');
  if (perEvent > maxBatch) throw new Error('Per-event limit cannot exceed the batch limit.');
  if (threshold > maxBatch) throw new Error('Immediate threshold cannot exceed the batch limit.');
}

export function nextRateWindow(now: Date, windowSeconds: number): { start: Date; end: Date } {
  const windowMs = windowSeconds * 1000;
  const startMs = Math.floor(now.getTime() / windowMs) * windowMs;
  return { start: new Date(startMs), end: new Date(startMs + windowMs) };
}
