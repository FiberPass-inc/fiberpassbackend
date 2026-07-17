import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  OCCURRENCE_STATUSES,
  SCHEDULE_CADENCES,
  SCHEDULE_EXECUTORS,
  SCHEDULE_STATUSES
} from '../domain/schedule.js';
import { PAYMENT_RAILS } from '../domain/payment.js';
import { assetIdField, atomicAmountField, moneyContractVersionField } from './moneyFields.js';

const paymentScheduleSchema = new Schema(
  {
    scheduleId: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    idempotencyKey: { type: String, required: true, trim: true },
    requestFingerprint: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    recipientId: { type: String, required: true, index: true },
    destinationId: { type: String, required: true, index: true },
    rail: { type: String, enum: PAYMENT_RAILS, required: true },
    network: { type: String, required: true, trim: true },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    amountAtomic: atomicAmountField({ required: true }),
    maxFeeAtomic: atomicAmountField({ required: true, default: '0' }),
    spentAtomic: atomicAmountField({ required: true, default: '0' }),
    executor: { type: String, enum: SCHEDULE_EXECUTORS, required: true },
    connectionId: { type: String, trim: true, index: true },
    cadence: { type: String, enum: SCHEDULE_CADENCES, required: true },
    timeZone: { type: String, required: true, trim: true },
    anchorDay: { type: Number, min: 1, max: 31 },
    customIntervalSeconds: { type: Number, min: 1, max: 31_536_000 },
    status: { type: String, enum: SCHEDULE_STATUSES, required: true, default: 'active', index: true },
    nextOccurrenceAt: { type: Date, required: true, index: true },
    lastOccurrenceAt: { type: Date },
    occurrenceLimit: { type: Number, min: 1, max: 1_000_000 },
    occurrenceCount: { type: Number, required: true, min: 0, default: 0 },
    completedAt: { type: Date },
    pausedAt: { type: Date },
    revokedAt: { type: Date },
    failureCode: { type: String, trim: true },
    failureMessage: { type: String, trim: true }
  },
  { timestamps: true, versionKey: false }
);
paymentScheduleSchema.index({ ownerWalletId: 1, sessionId: 1, createdAt: -1 });
paymentScheduleSchema.index({ ownerWalletId: 1, sessionId: 1, idempotencyKey: 1 }, { unique: true });
paymentScheduleSchema.index({ status: 1, nextOccurrenceAt: 1, createdAt: 1 });

const scheduledOccurrenceSchema = new Schema(
  {
    occurrenceId: { type: String, required: true, unique: true, index: true },
    scheduleId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    recipientId: { type: String, required: true, index: true },
    destinationId: { type: String, required: true, index: true },
    dueAt: { type: Date, required: true },
    rail: { type: String, enum: PAYMENT_RAILS, required: true },
    network: { type: String, required: true, trim: true },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    amountAtomic: atomicAmountField({ required: true }),
    status: { type: String, enum: OCCURRENCE_STATUSES, required: true, default: 'resolving', index: true },
    reservationState: { type: String, enum: ['none', 'reserved', 'released', 'spent'], required: true, default: 'none' },
    reservedAt: { type: Date },
    paymentRequestHash: { type: String, match: /^[0-9a-f]{64}$/ },
    paymentHash: { type: String, match: /^[0-9a-f]{64}$/, index: true },
    requestExpiresAt: { type: Date },
    executorPaymentId: { type: String, trim: true },
    proofKind: { type: String, trim: true },
    proofReference: { type: String, trim: true },
    executionLeaseId: { type: String, trim: true },
    executionLeaseExpiresAt: { type: Date, index: true },
    retryCount: { type: Number, required: true, min: 0, default: 0 },
    nextAttemptAt: { type: Date, index: true },
    resolvedAt: { type: Date },
    submittedAt: { type: Date },
    reconciledAt: { type: Date },
    completedAt: { type: Date },
    failureCode: { type: String, trim: true },
    failureMessage: { type: String, trim: true }
  },
  { timestamps: true, versionKey: false }
);
scheduledOccurrenceSchema.index({ scheduleId: 1, dueAt: 1 }, { unique: true });
scheduledOccurrenceSchema.index(
  { paymentRequestHash: 1 },
  { unique: true, partialFilterExpression: { paymentRequestHash: { $type: 'string' } } }
);
scheduledOccurrenceSchema.index({ status: 1, nextAttemptAt: 1, executionLeaseExpiresAt: 1 });

export type PaymentScheduleRecord = InferSchemaType<typeof paymentScheduleSchema>;
export type ScheduledOccurrenceRecord = InferSchemaType<typeof scheduledOccurrenceSchema>;
export const PaymentScheduleModel = model('PaymentSchedule', paymentScheduleSchema);
export const ScheduledOccurrenceModel = model('ScheduledOccurrence', scheduledOccurrenceSchema);
