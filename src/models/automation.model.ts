import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  AUTOMATION_PAYMENT_STATUSES,
  PAYMENT_BATCH_STATUSES,
  PAYMENT_JOB_STATUSES,
  RECIPIENT_STATUSES
} from '../domain/automation.js';
import { assetIdField, atomicAmountField, moneyContractVersionField } from './moneyFields.js';

const MONEY_MIN_MINOR = 1;
const DEFAULT_CURRENCY = 'CKB';

const recipientSchema = new Schema(
  {
    recipientId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    appId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    serviceAddress: { type: String, required: true, trim: true, index: true },
    addressType: { type: String, required: true, trim: true, default: 'ckb' },
    externalId: { type: String, trim: true },
    invoiceEndpoint: { type: String, trim: true },
    status: { type: String, enum: RECIPIENT_STATUSES, required: true, default: 'active', index: true },
    metadata: { type: Schema.Types.Mixed },
    disabledAt: { type: Date }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

recipientSchema.index({ ownerWalletId: 1, appId: 1, createdAt: -1 });
recipientSchema.index({ appId: 1, status: 1, createdAt: -1 });
recipientSchema.index({ appId: 1, externalId: 1 }, { unique: true, sparse: true });

const invoiceSchema = new Schema(
  {
    invoiceId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    appId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    recipientId: { type: String, required: true, index: true },
    batchId: { type: String, index: true },
    amount: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, required: true, min: MONEY_MIN_MINOR },
    amountAtomic: atomicAmountField(),
    currency: { type: String, required: true, default: DEFAULT_CURRENCY },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    status: { type: String, enum: AUTOMATION_PAYMENT_STATUSES, required: true, default: 'draft', index: true },
    type: { type: String, trim: true, default: 'Invoice payment' },
    description: { type: String, trim: true, default: '' },
    memo: { type: String, trim: true, default: '' },
    externalReference: { type: String, trim: true },
    idempotencyKey: { type: String, trim: true },
    fiberInvoice: { type: String, trim: true },
    fiberInvoiceHash: { type: String, trim: true, index: true },
    chargeAttemptId: { type: String, trim: true, index: true },
    paymentJobId: { type: String, trim: true, index: true },
    dueAt: { type: Date, index: true },
    queuedAt: { type: Date },
    processingAt: { type: Date },
    paidAt: { type: Date },
    failedAt: { type: Date },
    cancelledAt: { type: Date },
    lastFailureCode: { type: String, trim: true },
    lastFailureMessage: { type: String, trim: true },
    metadata: { type: Schema.Types.Mixed }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

invoiceSchema.index({ ownerWalletId: 1, appId: 1, createdAt: -1 });
invoiceSchema.index({ sessionId: 1, status: 1, createdAt: -1 });
invoiceSchema.index({ appId: 1, recipientId: 1, createdAt: -1 });
invoiceSchema.index({ appId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
invoiceSchema.index({ appId: 1, externalReference: 1 }, { unique: true, sparse: true });
invoiceSchema.index({ status: 1, dueAt: 1, createdAt: 1 });

const paymentJobSchema = new Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    appId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    invoiceId: { type: String, required: true },
    recipientId: { type: String, required: true, index: true },
    batchId: { type: String, index: true },
    amount: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, required: true, min: MONEY_MIN_MINOR },
    amountAtomic: atomicAmountField(),
    currency: { type: String, required: true, default: DEFAULT_CURRENCY },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    status: { type: String, enum: PAYMENT_JOB_STATUSES, required: true, default: 'queued', index: true },
    idempotencyKey: { type: String, trim: true },
    lockedAt: { type: Date, index: true },
    lockedBy: { type: String, trim: true, index: true },
    runAfter: { type: Date, required: true, default: Date.now, index: true },
    startedAt: { type: Date },
    succeededAt: { type: Date },
    failedAt: { type: Date },
    cancelledAt: { type: Date },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    maxAttempts: { type: Number, required: true, min: 1, default: 3 },
    lastFailureCode: { type: String, trim: true },
    lastFailureMessage: { type: String, trim: true },
    metadata: { type: Schema.Types.Mixed }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

paymentJobSchema.index({ invoiceId: 1 }, { unique: true });
paymentJobSchema.index({ appId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
paymentJobSchema.index({ status: 1, runAfter: 1, lockedAt: 1, createdAt: 1 });
paymentJobSchema.index({ ownerWalletId: 1, appId: 1, createdAt: -1 });

const paymentBatchSchema = new Schema(
  {
    batchId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    appId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    status: { type: String, enum: PAYMENT_BATCH_STATUSES, required: true, default: 'draft', index: true },
    description: { type: String, trim: true, default: '' },
    externalReference: { type: String, trim: true },
    idempotencyKey: { type: String, trim: true },
    totalAmount: { type: Number, required: true, min: 0, default: 0 },
    totalAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    totalAmountAtomic: atomicAmountField(),
    currency: { type: String, required: true, default: DEFAULT_CURRENCY },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    invoiceCount: { type: Number, required: true, min: 0, default: 0 },
    paidCount: { type: Number, required: true, min: 0, default: 0 },
    failedCount: { type: Number, required: true, min: 0, default: 0 },
    queuedAt: { type: Date },
    processingAt: { type: Date },
    completedAt: { type: Date },
    failedAt: { type: Date },
    cancelledAt: { type: Date },
    lastFailureCode: { type: String, trim: true },
    lastFailureMessage: { type: String, trim: true },
    metadata: { type: Schema.Types.Mixed }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

paymentBatchSchema.index({ ownerWalletId: 1, appId: 1, createdAt: -1 });
paymentBatchSchema.index({ sessionId: 1, status: 1, createdAt: -1 });
paymentBatchSchema.index({ appId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
paymentBatchSchema.index({ appId: 1, externalReference: 1 }, { unique: true, sparse: true });

export type RecipientRecord = InferSchemaType<typeof recipientSchema>;
export type InvoiceRecord = InferSchemaType<typeof invoiceSchema>;
export type PaymentJobRecord = InferSchemaType<typeof paymentJobSchema>;
export type PaymentBatchRecord = InferSchemaType<typeof paymentBatchSchema>;

export const RecipientModel = model('Recipient', recipientSchema);
export const InvoiceModel = model('Invoice', invoiceSchema);
export const PaymentJobModel = model('PaymentJob', paymentJobSchema);
export const PaymentBatchModel = model('PaymentBatch', paymentBatchSchema);
