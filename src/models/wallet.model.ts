import { Schema, model, type InferSchemaType } from 'mongoose';

const walletSchema = new Schema(
  {
    walletId: { type: String, required: true, unique: true },
    connected: { type: Boolean, required: true, default: true },
    address: { type: String, required: true },
    balance: { type: Number, required: true, min: 0, default: 1240.5 },
    balanceMinor: { type: Number, min: 0, default: 1240500000 },
    currency: { type: String, required: true, default: 'USDC' }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

export type WalletRecord = InferSchemaType<typeof walletSchema>;
export const WalletModel = model('Wallet', walletSchema);
