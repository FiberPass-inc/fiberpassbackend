import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  NOTIFICATION_DELIVERY_STATUSES,
  RECEIPT_SOURCE_TYPES,
  RECEIPT_STATUSES
} from '../domain/receipt.js';
import { PAYMENT_RAILS } from '../domain/payment.js';
import { CONTACT_CHANNEL_TYPES } from '../domain/identity.js';
import { assetIdField, atomicAmountField, moneyContractVersionField } from './moneyFields.js';

const immutable = { immutable: true } as const;

const paymentReceiptSchema = new Schema(
  {
    receiptId: { type: String, required: true, unique: true, index: true, ...immutable },
    version: { type: Number, required: true, enum: [1], default: 1, ...immutable },
    receiptHash: { type: String, required: true, unique: true, match: /^[0-9a-f]{64}$/, ...immutable },
    ownerWalletId: { type: String, required: true, index: true, ...immutable },
    recipientId: { type: String, index: true, ...immutable },
    sourceType: { type: String, enum: RECEIPT_SOURCE_TYPES, required: true, ...immutable },
    sourceId: { type: String, required: true, ...immutable },
    settlementId: { type: String, required: true, index: true, ...immutable },
    rail: { type: String, enum: PAYMENT_RAILS, required: true, ...immutable },
    network: { type: String, required: true, trim: true, ...immutable },
    assetId: { ...assetIdField(), ...immutable },
    moneyContractVersion: { ...moneyContractVersionField(), ...immutable },
    amountAtomic: { ...atomicAmountField({ required: true }), ...immutable },
    feeAtomic: { ...atomicAmountField({ required: true, default: '0' }), ...immutable },
    feeKnown: { type: Boolean, required: true, default: false, ...immutable },
    status: { type: String, enum: RECEIPT_STATUSES, required: true, ...immutable },
    paymentHash: { type: String, trim: true, ...immutable },
    proofKind: { type: String, trim: true, ...immutable },
    proofReference: { type: String, trim: true, ...immutable },
    settledAt: { type: Date, required: true, ...immutable }
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, strict: 'throw' }
);

paymentReceiptSchema.index({ sourceType: 1, sourceId: 1 }, { unique: true });
paymentReceiptSchema.index({ ownerWalletId: 1, settledAt: -1, receiptId: -1 });
paymentReceiptSchema.index({ recipientId: 1, settledAt: -1 });

const notificationDeliverySchema = new Schema(
  {
    deliveryId: { type: String, required: true, unique: true, index: true },
    receiptId: { type: String, required: true, index: true },
    endpointId: { type: String, required: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    channel: { type: String, enum: CONTACT_CHANNEL_TYPES, required: true },
    status: { type: String, enum: NOTIFICATION_DELIVERY_STATUSES, required: true, default: 'queued', index: true },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    maxAttempts: { type: Number, required: true, min: 1, max: 20, default: 5 },
    runAfter: { type: Date, required: true, default: Date.now, index: true },
    leaseId: { type: String, trim: true },
    leaseExpiresAt: { type: Date, index: true },
    remoteReference: { type: String, trim: true },
    deliveredAt: { type: Date },
    failedAt: { type: Date },
    cancelledAt: { type: Date },
    lastFailureCode: { type: String, trim: true },
    lastFailureMessage: { type: String, trim: true },
    expiresAt: { type: Date }
  },
  { timestamps: true, versionKey: false }
);

notificationDeliverySchema.index({ receiptId: 1, endpointId: 1 }, { unique: true });
notificationDeliverySchema.index({ status: 1, runAfter: 1, leaseExpiresAt: 1 });
notificationDeliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type PaymentReceiptRecord = InferSchemaType<typeof paymentReceiptSchema>;
export type NotificationDeliveryRecord = InferSchemaType<typeof notificationDeliverySchema>;

export const PaymentReceiptModel = model('PaymentReceipt', paymentReceiptSchema);
export const NotificationDeliveryModel = model('NotificationDelivery', notificationDeliverySchema);
