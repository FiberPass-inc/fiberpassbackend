import { Schema, model, type InferSchemaType } from 'mongoose';
import { assetIdField, atomicAmountField, moneyContractVersionField } from './moneyFields.js';

const walletSchema = new Schema(
  {
    walletId: { type: String, required: true, unique: true },
    connected: { type: Boolean, required: true, default: true },
    address: { type: String, required: true },
    balance: { type: Number, required: true, min: 0, default: 0 },
    balanceMinor: { type: Number, min: 0, default: 0 },
    balanceAtomic: atomicAmountField(),
    currency: { type: String, required: true, default: 'CKB' },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField()
  },
  {
    timestamps: true,
    versionKey: false
  }
);

export type WalletRecord = InferSchemaType<typeof walletSchema>;
export const WalletModel = model('Wallet', walletSchema);
