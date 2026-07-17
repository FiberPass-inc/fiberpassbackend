import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  METERED_BATCH_STATUSES,
  METERED_EXECUTORS,
  METERED_GRANT_STATUSES,
  USAGE_EVENT_STATUSES
} from '../domain/meteredPayment.js';
import { PAYMENT_RAILS } from '../domain/payment.js';
import { assetIdField, atomicAmountField, moneyContractVersionField } from './moneyFields.js';

const meteredGrantSchema = new Schema(
  {
    grantId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    appId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    recipientId: { type: String, required: true, index: true },
    destinationId: { type: String, required: true, index: true },
    rail: { type: String, enum: PAYMENT_RAILS, required: true },
    network: { type: String, required: true, trim: true },
    assetId: { ...assetIdField(), immutable: true },
    executor: { type: String, enum: METERED_EXECUTORS, required: true },
    connectionId: { type: String, trim: true },
    status: { type: String, enum: METERED_GRANT_STATUSES, required: true, default: 'active', index: true },
    maxPerEventAtomic: atomicAmountField({ required: true }),
    totalLimitAtomic: atomicAmountField({ required: true }),
    reservedAtomic: atomicAmountField({ required: true, default: '0' }),
    spentAtomic: atomicAmountField({ required: true, default: '0' }),
    rateLimitCount: { type: Number, required: true, min: 1, max: 100000 },
    rateLimitWindowSeconds: { type: Number, required: true, min: 1, max: 86400 },
    immediateThresholdAtomic: atomicAmountField({ required: true }),
    maxBatchAtomic: atomicAmountField({ required: true }),
    maxBatchEvents: { type: Number, required: true, min: 1, max: 1000 },
    settlementDelayMs: { type: Number, required: true, min: 0, max: 3600000 },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date },
    moneyContractVersion: moneyContractVersionField()
  },
  { timestamps: true, versionKey: false }
);

meteredGrantSchema.index({ ownerWalletId: 1, appId: 1, createdAt: -1 });
meteredGrantSchema.index({ sessionId: 1, status: 1, expiresAt: 1 });

const usageEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true, immutable: true },
    receiptId: { type: String, required: true, unique: true, index: true, immutable: true },
    externalId: { type: String, required: true, trim: true, immutable: true },
    requestFingerprint: { type: String, required: true, match: /^[0-9a-f]{64}$/, immutable: true },
    ownerWalletId: { type: String, required: true, index: true, immutable: true },
    appId: { type: String, required: true, index: true, immutable: true },
    grantId: { type: String, required: true, index: true, immutable: true },
    sessionId: { type: String, required: true, index: true, immutable: true },
    recipientId: { type: String, required: true, index: true, immutable: true },
    destinationId: { type: String, required: true, immutable: true },
    rail: { type: String, enum: PAYMENT_RAILS, required: true, immutable: true },
    network: { type: String, required: true, trim: true, immutable: true },
    assetId: { ...assetIdField(), immutable: true },
    amountAtomic: { ...atomicAmountField({ required: true }), immutable: true },
    type: { type: String, required: true, trim: true, immutable: true },
    policyReference: { type: String, required: true, trim: true, immutable: true },
    metadata: { type: Schema.Types.Mixed, immutable: true },
    batchId: { type: String, index: true, immutable: true },
    status: { type: String, enum: USAGE_EVENT_STATUSES, required: true, default: 'reserved', index: true },
    reservationDay: { type: String, required: true, trim: true, immutable: true },
    acceptedAt: { type: Date, required: true, immutable: true },
    settlingAt: { type: Date },
    settledAt: { type: Date },
    releasedAt: { type: Date },
    proofKind: { type: String, trim: true },
    proofReference: { type: String, trim: true },
    paymentRequestHash: { type: String, trim: true },
    failureCode: { type: String, trim: true },
    failureMessage: { type: String, trim: true },
    moneyContractVersion: moneyContractVersionField()
  },
  { timestamps: true, versionKey: false }
);

usageEventSchema.index({ appId: 1, externalId: 1 }, { unique: true });
usageEventSchema.index({ grantId: 1, status: 1, acceptedAt: 1 });
usageEventSchema.index({ batchId: 1, status: 1, acceptedAt: 1 });
usageEventSchema.index({ ownerWalletId: 1, appId: 1, createdAt: -1 });

const meteredBatchSchema = new Schema(
  {
    batchId: { type: String, required: true, unique: true, index: true },
    batchKey: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    accepting: { type: Boolean, required: true, default: true },
    ownerWalletId: { type: String, required: true, index: true },
    appId: { type: String, required: true, index: true },
    grantId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    recipientId: { type: String, required: true, index: true },
    destinationId: { type: String, required: true },
    rail: { type: String, enum: PAYMENT_RAILS, required: true },
    network: { type: String, required: true, trim: true },
    assetId: { ...assetIdField(), immutable: true },
    executor: { type: String, enum: METERED_EXECUTORS, required: true },
    connectionId: { type: String, trim: true },
    status: { type: String, enum: METERED_BATCH_STATUSES, required: true, default: 'collecting', index: true },
    totalAtomic: atomicAmountField({ required: true, default: '0' }),
    eventCount: { type: Number, required: true, min: 0, default: 0 },
    runAfter: { type: Date, required: true, index: true },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    maxAttempts: { type: Number, required: true, min: 1, default: 5 },
    leaseId: { type: String, trim: true },
    leaseExpiresAt: { type: Date, index: true },
    submittedAt: { type: Date },
    completedAt: { type: Date },
    paymentRequestHash: { type: String, trim: true },
    paymentHash: { type: String, trim: true },
    providerPaymentId: { type: String, trim: true, index: true },
    proofKind: { type: String, trim: true },
    proofReference: { type: String, trim: true },
    failureCode: { type: String, trim: true },
    failureMessage: { type: String, trim: true },
    moneyContractVersion: moneyContractVersionField()
  },
  { timestamps: true, versionKey: false }
);

meteredBatchSchema.index(
  { batchKey: 1, accepting: 1 },
  { unique: true, partialFilterExpression: { accepting: true } }
);
meteredBatchSchema.index({ status: 1, runAfter: 1, leaseExpiresAt: 1 });
meteredBatchSchema.index({ grantId: 1, status: 1, createdAt: 1 });
meteredBatchSchema.index(
  { paymentRequestHash: 1 },
  { unique: true, partialFilterExpression: { paymentRequestHash: { $type: 'string' } } }
);

const meteredRateCounterSchema = new Schema(
  {
    grantId: { type: String, required: true, index: true },
    windowStart: { type: Date, required: true },
    windowEnd: { type: Date, required: true, index: true },
    count: { type: Number, required: true, min: 0, default: 0 }
  },
  { timestamps: true, versionKey: false }
);

meteredRateCounterSchema.index({ grantId: 1, windowStart: 1 }, { unique: true });

export type MeteredGrantRecord = InferSchemaType<typeof meteredGrantSchema>;
export type UsageEventRecord = InferSchemaType<typeof usageEventSchema>;
export type MeteredBatchRecord = InferSchemaType<typeof meteredBatchSchema>;
export type MeteredRateCounterRecord = InferSchemaType<typeof meteredRateCounterSchema>;

export const MeteredGrantModel = model('MeteredGrant', meteredGrantSchema);
export const UsageEventModel = model('UsageEvent', usageEventSchema);
export const MeteredBatchModel = model('MeteredBatch', meteredBatchSchema);
export const MeteredRateCounterModel = model('MeteredRateCounter', meteredRateCounterSchema);
