import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  NWC_CONNECTION_STATUSES,
  NWC_ENCRYPTION_SCHEMES,
  NWC_EXECUTION_MODES,
  NWC_METHODS,
  NWC_NETWORKS,
  NWC_PAYMENT_STATUSES,
  NWC_SCOPE_TYPES
} from '../domain/nwc.js';
import { assetIdField, atomicAmountField, moneyContractVersionField } from './moneyFields.js';

const nwcConnectionSchema = new Schema(
  {
    connectionId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    scopeType: { type: String, enum: NWC_SCOPE_TYPES, required: true, index: true },
    scopeId: { type: String, required: true, trim: true, index: true },
    status: { type: String, enum: NWC_CONNECTION_STATUSES, required: true, default: 'active', index: true },
    executionMode: { type: String, enum: NWC_EXECUTION_MODES, required: true, default: 'interactive' },
    walletPubkey: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    clientPubkey: { type: String, required: true, unique: true, match: /^[0-9a-f]{64}$/ },
    clientKeyFingerprint: { type: String, required: true, trim: true },
    relayUrls: { type: [String], required: true, validate: [(value: string[]) => value.length >= 1 && value.length <= 5, 'NWC relay count is invalid.'] },
    selectedRelay: { type: String, required: true, trim: true },
    secretCiphertext: { type: String, required: true, select: false },
    encryption: { type: String, enum: NWC_ENCRYPTION_SCHEMES, required: true },
    methods: { type: [{ type: String, enum: NWC_METHODS }], default: [] },
    advertisedMethods: { type: [String], default: [] },
    notifications: { type: [String], default: [] },
    infoEventId: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    infoResponseEventId: { type: String, match: /^[0-9a-f]{64}$/ },
    network: { type: String, enum: NWC_NETWORKS, required: true, index: true },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    lud16: { type: String, trim: true },
    allowanceEnforced: { type: Boolean, required: true, default: false },
    allowanceAtomic: atomicAmountField({ required: true, default: '0' }),
    allowanceUsedAtomic: atomicAmountField({ required: true, default: '0' }),
    allowanceResetsAt: { type: Date },
    allowanceProofEventId: { type: String, match: /^[0-9a-f]{64}$/ },
    balanceAtomic: atomicAmountField({ required: true, default: '0' }),
    balanceObservedAt: { type: Date },
    balanceStaleAt: { type: Date, index: true },
    lastUsedAt: { type: Date },
    lastFailureCode: { type: String, trim: true },
    lastFailureMessage: { type: String, trim: true },
    revokedAt: { type: Date },
    revokeReason: { type: String, trim: true }
  },
  { timestamps: true, versionKey: false }
);

nwcConnectionSchema.index({ ownerWalletId: 1, status: 1, createdAt: -1 });
nwcConnectionSchema.index({ ownerWalletId: 1, scopeType: 1, scopeId: 1, status: 1 });

const nwcPaymentSchema = new Schema(
  {
    paymentId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    connectionId: { type: String, required: true, index: true },
    idempotencyKey: { type: String, required: true, trim: true },
    requestFingerprint: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    paymentHash: { type: String, required: true, match: /^[0-9a-f]{64}$/, index: true },
    invoiceHash: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    network: { type: String, enum: NWC_NETWORKS, required: true },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    amountAtomic: atomicAmountField({ required: true }),
    feeAtomic: atomicAmountField({ required: true, default: '0' }),
    status: { type: String, enum: NWC_PAYMENT_STATUSES, required: true, default: 'pending', index: true },
    executionMode: { type: String, enum: NWC_EXECUTION_MODES, required: true },
    requestEventId: { type: String, match: /^[0-9a-f]{64}$/ },
    responseEventId: { type: String, match: /^[0-9a-f]{64}$/ },
    preimageVerified: { type: Boolean, required: true, default: false },
    executionLeaseId: { type: String, trim: true },
    executionLeaseExpiresAt: { type: Date, index: true },
    submittedAt: { type: Date },
    reconciledAt: { type: Date },
    succeededAt: { type: Date },
    failedAt: { type: Date },
    failureCode: { type: String, trim: true },
    failureMessage: { type: String, trim: true }
  },
  { timestamps: true, versionKey: false }
);

nwcPaymentSchema.index({ ownerWalletId: 1, connectionId: 1, idempotencyKey: 1 }, { unique: true });
nwcPaymentSchema.index({ ownerWalletId: 1, paymentHash: 1 }, { unique: true });
nwcPaymentSchema.index({ status: 1, executionLeaseExpiresAt: 1, updatedAt: 1 });

export type NwcConnectionRecord = InferSchemaType<typeof nwcConnectionSchema>;
export type NwcPaymentRecord = InferSchemaType<typeof nwcPaymentSchema>;
export const NwcConnectionModel = model('NwcConnection', nwcConnectionSchema);
export const NwcPaymentModel = model('NwcPayment', nwcPaymentSchema);
