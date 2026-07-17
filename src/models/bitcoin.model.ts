import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  BITCOIN_NETWORKS,
  BITCOIN_PSBT_STATUSES,
  BTCPAY_CONNECTION_STATUSES,
  BTCPAY_INVOICE_STATUSES,
  BTCPAY_PAYMENT_STATUSES,
  BTCPAY_SCOPE_TYPES
} from '../domain/bitcoin.js';
import { assetIdField, atomicAmountField, moneyContractVersionField } from './moneyFields.js';

const btcpayConnectionSchema = new Schema(
  {
    connectionId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    scopeType: { type: String, enum: BTCPAY_SCOPE_TYPES, required: true, index: true },
    scopeId: { type: String, required: true, trim: true, index: true },
    network: { type: String, enum: BITCOIN_NETWORKS, required: true, index: true },
    serverOrigin: { type: String, required: true, trim: true },
    storeId: { type: String, required: true, trim: true },
    apiKeyCiphertext: { type: String, required: true, select: false },
    apiKeyFingerprint: { type: String, required: true, unique: true, match: /^[0-9a-f]{64}$/ },
    permissions: { type: [String], required: true, default: [] },
    status: { type: String, enum: BTCPAY_CONNECTION_STATUSES, required: true, default: 'active', index: true },
    lastUsedAt: { type: Date },
    lastFailureCode: { type: String, trim: true },
    revokedAt: { type: Date },
    revokeReason: { type: String, trim: true },
    remoteRevoked: { type: Boolean, required: true, default: false }
  },
  { timestamps: true, versionKey: false }
);
btcpayConnectionSchema.index({ ownerWalletId: 1, status: 1, createdAt: -1 });
btcpayConnectionSchema.index({ ownerWalletId: 1, scopeType: 1, scopeId: 1, status: 1 });

const btcpayInvoiceSchema = new Schema(
  {
    invoiceId: { type: String, required: true, unique: true, index: true },
    providerInvoiceId: { type: String, trim: true },
    connectionId: { type: String, required: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    idempotencyKey: { type: String, required: true, trim: true },
    requestFingerprint: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    rail: { type: String, enum: ['lightning', 'bitcoin_onchain'], required: true },
    network: { type: String, enum: BITCOIN_NETWORKS, required: true },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    amountAtomic: atomicAmountField({ required: true }),
    creationStatus: { type: String, enum: ['creating', 'ready', 'uncertain'], required: true, default: 'creating', index: true },
    creationLeaseExpiresAt: { type: Date, index: true },
    status: { type: String, enum: BTCPAY_INVOICE_STATUSES, required: true, default: 'new', index: true },
    paymentRequestHash: { type: String, match: /^[0-9a-f]{64}$/ },
    checkoutLink: { type: String, trim: true },
    expiresAt: { type: Date, index: true },
    paidAt: { type: Date }
  },
  { timestamps: true, versionKey: false }
);
btcpayInvoiceSchema.index({ ownerWalletId: 1, connectionId: 1, idempotencyKey: 1 }, { unique: true });
btcpayInvoiceSchema.index(
  { connectionId: 1, providerInvoiceId: 1 },
  { unique: true, partialFilterExpression: { providerInvoiceId: { $type: 'string' } } }
);

const btcpayPaymentSchema = new Schema(
  {
    paymentId: { type: String, required: true, unique: true, index: true },
    connectionId: { type: String, required: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    idempotencyKey: { type: String, required: true, trim: true },
    requestFingerprint: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    paymentHash: { type: String, required: true, match: /^[0-9a-f]{64}$/, index: true },
    invoiceHash: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    network: { type: String, enum: BITCOIN_NETWORKS, required: true },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    amountAtomic: atomicAmountField({ required: true }),
    feeAtomic: atomicAmountField({ required: true, default: '0' }),
    maxFeeAtomic: atomicAmountField({ required: true }),
    status: { type: String, enum: BTCPAY_PAYMENT_STATUSES, required: true, default: 'pending', index: true },
    providerPaymentId: { type: String, trim: true },
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
btcpayPaymentSchema.index({ ownerWalletId: 1, connectionId: 1, idempotencyKey: 1 }, { unique: true });
btcpayPaymentSchema.index({ ownerWalletId: 1, paymentHash: 1 }, { unique: true });
btcpayPaymentSchema.index({ status: 1, executionLeaseExpiresAt: 1, updatedAt: 1 });

const psbtInputSchema = new Schema({
  txid: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
  vout: { type: Number, required: true, min: 0 },
  valueAtomic: atomicAmountField({ required: true }),
  scriptHex: { type: String, required: true, match: /^[0-9a-f]+$/ },
  inputType: { type: String, enum: ['p2wpkh', 'p2tr'], required: true },
  confirmations: { type: Number, required: true, min: 0 }
}, { _id: false });

const bitcoinPsbtSchema = new Schema(
  {
    psbtId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    scopeType: { type: String, enum: BTCPAY_SCOPE_TYPES, required: true, index: true },
    scopeId: { type: String, required: true, trim: true, index: true },
    idempotencyKey: { type: String, required: true, trim: true },
    requestFingerprint: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    network: { type: String, enum: BITCOIN_NETWORKS, required: true, index: true },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    recipientAddress: { type: String, required: true, trim: true },
    recipientScriptHex: { type: String, required: true, match: /^[0-9a-f]+$/ },
    amountAtomic: atomicAmountField({ required: true }),
    feeAtomic: atomicAmountField({ required: true }),
    maxFeeAtomic: atomicAmountField({ required: true }),
    feeRateSatVb: atomicAmountField({ required: true }),
    changeAddress: { type: String, trim: true },
    changeScriptHex: { type: String, match: /^[0-9a-f]+$/ },
    changeAtomic: atomicAmountField(),
    inputs: { type: [psbtInputSchema], required: true },
    unsignedPsbt: { type: String, required: true, select: false },
    unsignedFingerprint: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    outputPlanHash: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    status: { type: String, enum: BITCOIN_PSBT_STATUSES, required: true, default: 'awaiting_signature', index: true },
    rawTransactionHex: { type: String, select: false },
    txid: { type: String, match: /^[0-9a-f]{64}$/, index: true, sparse: true },
    requiredConfirmations: { type: Number, required: true, min: 1, max: 100 },
    confirmations: { type: Number, required: true, min: 0, default: 0 },
    replaceable: { type: Boolean, required: true, default: true },
    replacesPsbtId: { type: String, trim: true, index: true },
    replacedByPsbtId: { type: String, trim: true },
    submittedAt: { type: Date },
    broadcastAt: { type: Date },
    confirmedAt: { type: Date },
    replacedAt: { type: Date },
    abandonedAt: { type: Date },
    failureCode: { type: String, trim: true },
    failureMessage: { type: String, trim: true }
  },
  { timestamps: true, versionKey: false }
);
bitcoinPsbtSchema.index({ ownerWalletId: 1, idempotencyKey: 1 }, { unique: true });
bitcoinPsbtSchema.index({ ownerWalletId: 1, status: 1, createdAt: -1 });

export type BtcpayConnectionRecord = InferSchemaType<typeof btcpayConnectionSchema>;
export type BtcpayInvoiceRecord = InferSchemaType<typeof btcpayInvoiceSchema>;
export type BtcpayPaymentRecord = InferSchemaType<typeof btcpayPaymentSchema>;
export type BitcoinPsbtRecord = InferSchemaType<typeof bitcoinPsbtSchema>;
export const BtcpayConnectionModel = model('BtcpayConnection', btcpayConnectionSchema);
export const BtcpayInvoiceModel = model('BtcpayInvoice', btcpayInvoiceSchema);
export const BtcpayPaymentModel = model('BtcpayPayment', btcpayPaymentSchema);
export const BitcoinPsbtModel = model('BitcoinPsbt', bitcoinPsbtSchema);
