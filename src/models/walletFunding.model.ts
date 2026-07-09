import { Schema, model, type InferSchemaType } from 'mongoose';

export const WALLET_FUNDING_STATUSES = ['pending', 'confirmed'] as const;
export type WalletFundingStatus = (typeof WALLET_FUNDING_STATUSES)[number];

const walletFundingSchema = new Schema(
  {
    fundingId: { type: String, required: true, unique: true, index: true },
    walletId: { type: String, required: true, index: true },
    walletAddress: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, default: 'USDC' },
    network: { type: String, required: true, trim: true },
    depositMode: { type: String, required: true, trim: true, default: 'treasury' },
    depositAddress: { type: String, required: true, trim: true },
    vaultScriptHash: { type: String, trim: true, index: true },
    vaultScriptArgs: { type: String, trim: true },
    vaultOwnerLockHash: { type: String, trim: true },
    vaultOwnerLockHashSource: { type: String, trim: true },
    vaultAccountIdHash: { type: String, trim: true, index: true },
    memo: { type: String, required: true, trim: true },
    proofId: { type: String, trim: true },
    status: { type: String, enum: WALLET_FUNDING_STATUSES, required: true, default: 'pending', index: true },
    confirmedAt: { type: Date }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

walletFundingSchema.index({ walletId: 1, createdAt: -1 });
walletFundingSchema.index({ proofId: 1 }, { unique: true, sparse: true });

export type WalletFundingRecord = InferSchemaType<typeof walletFundingSchema>;
export const WalletFundingModel = model('WalletFunding', walletFundingSchema);
