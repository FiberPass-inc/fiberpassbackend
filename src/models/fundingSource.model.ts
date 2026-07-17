import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  FUNDING_ALLOCATION_STATES,
  FUNDING_GUARANTEES,
  FUNDING_MODES,
  FUNDING_RISK_LABELS,
  FUNDING_SOURCE_KINDS,
  FUNDING_SOURCE_STATES
} from '../domain/funding.js';
import { assetIdField, atomicAmountField, moneyContractVersionField } from './moneyFields.js';

function minorField(defaultValue = 0) {
  return { type: Number, required: true, min: 0, default: defaultValue };
}

const fundingSourceSchema = new Schema(
  {
    sourceId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    mode: { type: String, enum: FUNDING_MODES, required: true, index: true },
    sourceKind: { type: String, enum: FUNDING_SOURCE_KINDS, required: true },
    sourceReference: { type: String, required: true, trim: true },
    connectorId: { type: String, trim: true },
    rail: { type: String, required: true, trim: true },
    network: { type: String, required: true, trim: true },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    guarantee: { type: String, enum: FUNDING_GUARANTEES, required: true },
    riskLabel: { type: String, enum: FUNDING_RISK_LABELS, required: true, default: 'none' },
    state: { type: String, enum: FUNDING_SOURCE_STATES, required: true, default: 'unverified', index: true },
    availableMinor: minorField(),
    availableAtomic: atomicAmountField(),
    authorizedMinor: minorField(),
    authorizedAtomic: atomicAmountField(),
    lockedMinor: minorField(),
    lockedAtomic: atomicAmountField(),
    reservedMinor: minorField(),
    reservedAtomic: atomicAmountField(),
    spentMinor: minorField(),
    spentAtomic: atomicAmountField(),
    releasedMinor: minorField(),
    releasedAtomic: atomicAmountField(),
    reclaimableMinor: minorField(),
    reclaimableAtomic: atomicAmountField(),
    networkProofId: { type: String, trim: true },
    networkProofType: { type: String, trim: true },
    proofObservedAt: { type: Date },
    balanceObservedAt: { type: Date },
    staleAt: { type: Date, index: true },
    failureCode: { type: String, trim: true },
    failureMessage: { type: String, trim: true }
  },
  { timestamps: true, versionKey: false }
);

fundingSourceSchema.index({ ownerWalletId: 1, mode: 1, assetId: 1, createdAt: -1 });
fundingSourceSchema.index({ ownerWalletId: 1, mode: 1, sourceReference: 1, rail: 1, assetId: 1 }, { unique: true });
fundingSourceSchema.pre('validate', function validateSecuredProof(next) {
  if (this.mode === 'secured_autopay' && this.lockedMinor > 0 && !this.networkProofId) {
    this.invalidate('networkProofId', 'Secured auto-pay locked funds require a network proof.');
  }
  next();
});

const fundingAllocationSchema = new Schema(
  {
    allocationId: { type: String, required: true, unique: true, index: true },
    sourceId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    mode: { type: String, enum: FUNDING_MODES, required: true },
    guarantee: { type: String, enum: FUNDING_GUARANTEES, required: true },
    riskLabel: { type: String, enum: FUNDING_RISK_LABELS, required: true, default: 'none' },
    state: { type: String, enum: FUNDING_ALLOCATION_STATES, required: true, default: 'active', index: true },
    assetId: assetIdField(),
    moneyContractVersion: moneyContractVersionField(),
    authorizedMinor: minorField(),
    authorizedAtomic: atomicAmountField(),
    spentMinor: minorField(),
    spentAtomic: atomicAmountField(),
    releasedMinor: minorField(),
    releasedAtomic: atomicAmountField(),
    remainingMinor: minorField(),
    remainingAtomic: atomicAmountField(),
    networkProofIdAtAllocation: { type: String, trim: true },
    activatedAt: { type: Date, required: true, default: Date.now },
    releasedAt: { type: Date },
    exhaustedAt: { type: Date }
  },
  { timestamps: true, versionKey: false }
);

fundingAllocationSchema.index({ ownerWalletId: 1, state: 1, createdAt: -1 });
fundingAllocationSchema.pre('validate', function validateAllocation(next) {
  if (this.spentMinor + this.releasedMinor > this.authorizedMinor) {
    this.invalidate('authorizedMinor', 'Spent plus released cannot exceed the funding authorization.');
  }
  if (this.mode === 'secured_autopay' && !this.networkProofIdAtAllocation && this.riskLabel !== 'legacy_operator_vault') {
    this.invalidate('networkProofIdAtAllocation', 'Secured auto-pay allocations require a network proof.');
  }
  next();
});

export type FundingSourceRecord = InferSchemaType<typeof fundingSourceSchema>;
export type FundingAllocationRecord = InferSchemaType<typeof fundingAllocationSchema>;
export const FundingSourceModel = model('FundingSource', fundingSourceSchema);
export const FundingAllocationModel = model('FundingAllocation', fundingAllocationSchema);
