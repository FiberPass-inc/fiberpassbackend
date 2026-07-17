import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  CLAIM_STATUSES,
  CONTACT_CHANNEL_TYPES,
  DESTINATION_KINDS,
  DESTINATION_STATUSES,
  DESTINATION_VERIFICATION_METHODS,
  DESTINATION_VERIFICATION_SCOPES,
  PRINCIPAL_PROOF_TYPES
} from '../domain/identity.js';

const walletPrincipalSchema = new Schema(
  {
    principalId: { type: String, required: true, unique: true, index: true },
    walletId: { type: String, required: true, unique: true, index: true },
    address: { type: String, required: true, trim: true },
    proofType: { type: String, enum: PRINCIPAL_PROOF_TYPES, required: true },
    verifiedAt: { type: Date, required: true }
  },
  { timestamps: true, versionKey: false }
);

const recipientIdentitySchema = new Schema(
  {
    recipientId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    sessionId: { type: String, trim: true, index: true },
    sessionRecipientIndex: { type: Number, min: 0 },
    automationRecipientId: { type: String, trim: true, index: true },
    contactDeletedAt: { type: Date }
  },
  { timestamps: true, versionKey: false }
);

recipientIdentitySchema.index({ sessionId: 1, sessionRecipientIndex: 1 }, { unique: true, sparse: true });

const paymentDestinationSchema = new Schema(
  {
    destinationId: { type: String, required: true, unique: true, index: true },
    recipientId: { type: String, required: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    rail: { type: String, enum: ['ckb_onchain', 'fiber'], required: true },
    network: { type: String, required: true, trim: true },
    kind: { type: String, enum: DESTINATION_KINDS, required: true },
    value: { type: String, required: true, trim: true },
    valueHash: { type: String, required: true, index: true },
    reusable: { type: Boolean, required: true },
    status: { type: String, enum: DESTINATION_STATUSES, required: true, default: 'active', index: true },
    verificationMethod: { type: String, enum: DESTINATION_VERIFICATION_METHODS, required: true },
    verificationScope: { type: String, enum: DESTINATION_VERIFICATION_SCOPES, required: true },
    verifiedAt: { type: Date, required: true },
    replacedAt: { type: Date },
    replacedByDestinationId: { type: String, trim: true },
    revokedAt: { type: Date }
  },
  { timestamps: true, versionKey: false }
);

paymentDestinationSchema.index({ recipientId: 1, status: 1, createdAt: -1 });

const claimChannelSchema = new Schema(
  {
    channelId: { type: String, required: true, unique: true, index: true },
    recipientId: { type: String, required: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    type: { type: String, enum: CONTACT_CHANNEL_TYPES, required: true },
    value: { type: String, trim: true },
    valueHash: { type: String, trim: true, index: true },
    status: { type: String, enum: ['active', 'deleted'], required: true, default: 'active' },
    deliveryVerifiedAt: { type: Date },
    deletedAt: { type: Date }
  },
  { timestamps: true, versionKey: false }
);

const notificationEndpointSchema = new Schema(
  {
    endpointId: { type: String, required: true, unique: true, index: true },
    recipientId: { type: String, required: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    type: { type: String, enum: CONTACT_CHANNEL_TYPES, required: true },
    purpose: { type: String, enum: ['receipt'], required: true, default: 'receipt' },
    value: { type: String, trim: true },
    valueHash: { type: String, trim: true, index: true },
    status: { type: String, enum: ['active', 'deleted'], required: true, default: 'active' },
    deletedAt: { type: Date }
  },
  { timestamps: true, versionKey: false }
);

const recipientClaimSchema = new Schema(
  {
    claimId: { type: String, required: true, unique: true, index: true },
    recipientId: { type: String, required: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    sessionRecipientIndex: { type: Number, required: true, min: 0 },
    channelId: { type: String, trim: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    purpose: { type: String, enum: ['bind_destination'], required: true, default: 'bind_destination' },
    status: { type: String, enum: CLAIM_STATUSES, required: true, default: 'pending', index: true },
    expiresAt: { type: Date, required: true, index: true },
    claimedAt: { type: Date },
    revokedAt: { type: Date },
    destinationId: { type: String, trim: true },
    contactVerifiedAt: { type: Date }
  },
  { timestamps: true, versionKey: false }
);

recipientClaimSchema.index({ recipientId: 1, status: 1, createdAt: -1 });

export type WalletPrincipalRecord = InferSchemaType<typeof walletPrincipalSchema>;
export type RecipientIdentityRecord = InferSchemaType<typeof recipientIdentitySchema>;
export type PaymentDestinationRecord = InferSchemaType<typeof paymentDestinationSchema>;
export type ClaimChannelRecord = InferSchemaType<typeof claimChannelSchema>;
export type NotificationEndpointRecord = InferSchemaType<typeof notificationEndpointSchema>;
export type RecipientClaimRecord = InferSchemaType<typeof recipientClaimSchema>;

export const WalletPrincipalModel = model('WalletPrincipal', walletPrincipalSchema);
export const RecipientIdentityModel = model('RecipientIdentity', recipientIdentitySchema);
export const PaymentDestinationModel = model('PaymentDestination', paymentDestinationSchema);
export const ClaimChannelModel = model('ClaimChannel', claimChannelSchema);
export const NotificationEndpointModel = model('NotificationEndpoint', notificationEndpointSchema);
export const RecipientClaimModel = model('RecipientClaim', recipientClaimSchema);
