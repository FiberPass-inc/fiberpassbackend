import { Schema, model, type InferSchemaType } from 'mongoose';
import { assetIdField, atomicAmountField, moneyContractVersionField } from './moneyFields.js';

const chargeDailyCounterSchema = new Schema(
  {
    sessionId: { type: String, required: true, index: true },
    day: { type: String, required: true },
    spentMinor: { type: Number, required: true, min: 0, default: 0 },
    spentAtomic: atomicAmountField(),
    reservedMinor: { type: Number, required: true, min: 0, default: 0 },
    reservedAtomic: atomicAmountField(),
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField()
  },
  {
    timestamps: true,
    versionKey: false
  }
);

chargeDailyCounterSchema.index({ sessionId: 1, day: 1 }, { unique: true });

export type ChargeDailyCounterRecord = InferSchemaType<typeof chargeDailyCounterSchema>;
export const ChargeDailyCounterModel = model('ChargeDailyCounter', chargeDailyCounterSchema);
