import type { Model } from 'mongoose';
import { assetIdForLegacyCurrency, PAYMENT_CONTRACT_VERSION } from '../domain/payment.js';
import { asAtomicAmount, legacyMinorToAtomicAmount } from '../lib/money.js';
import { InvoiceModel, PaymentBatchModel, PaymentJobModel } from '../models/automation.model.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { ChargeDailyCounterModel } from '../models/chargeDailyCounter.model.js';
import { SessionModel } from '../models/session.model.js';
import { WalletModel } from '../models/wallet.model.js';
import { WalletFundingModel } from '../models/walletFunding.model.js';

export type LegacyMoneyRecordKind = 'wallet' | 'walletFunding' | 'session' | 'chargeAttempt' | 'dailyCounter' | 'invoice' | 'paymentJob' | 'paymentBatch';

const TOP_LEVEL_FIELDS: Record<LegacyMoneyRecordKind, readonly (readonly [string, string])[]> = {
  wallet: [['balanceMinor', 'balanceAtomic']],
  walletFunding: [['amountMinor', 'amountAtomic'], ['chainCapacityShannons', 'chainCapacityAtomic']],
  session: [
    ['maxChargeAmountMinor', 'maxChargeAmountAtomic'],
    ['platformFeeEstimateMinor', 'platformFeeEstimateAtomic'],
    ['networkFeeEstimateMinor', 'networkFeeEstimateAtomic'],
    ['spentMinor', 'spentAtomic'],
    ['reservedMinor', 'reservedAtomic'],
    ['limitMinor', 'limitAtomic'],
    ['lifecycleAmountMinor', 'lifecycleAmountAtomic']
  ],
  chargeAttempt: [
    ['amountMinor', 'amountAtomic'],
    ['resultingSpentMinor', 'resultingSpentAtomic'],
    ['remainingBalanceMinor', 'remainingBalanceAtomic']
  ],
  dailyCounter: [['spentMinor', 'spentAtomic'], ['reservedMinor', 'reservedAtomic']],
  invoice: [['amountMinor', 'amountAtomic']],
  paymentJob: [['amountMinor', 'amountAtomic']],
  paymentBatch: [['totalAmountMinor', 'totalAmountAtomic']]
};

function migratedAtomicValue(record: Record<string, unknown>, legacyField: string, atomicField: string, prefix = ''): string | undefined {
  const atomic = record[atomicField];
  const legacy = record[legacyField];
  if (legacy == null && atomic == null) return undefined;
  if (legacy == null) return asAtomicAmount(atomic);
  const migrated = legacyMinorToAtomicAmount(legacy, prefix + legacyField);
  if (atomic != null && asAtomicAmount(atomic) !== migrated) {
    throw new Error(prefix + atomicField + ' conflicts with ' + legacyField + '.');
  }
  return migrated;
}

function migrateArrayMoney(
  value: unknown,
  fieldPairs: readonly (readonly [string, string])[],
  prefix: string
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(prefix + '[' + index + '] must be an object.');
    const migrated = { ...(entry as Record<string, unknown>) };
    for (const [legacyField, atomicField] of fieldPairs) {
      const atomic = migratedAtomicValue(migrated, legacyField, atomicField, prefix + '[' + index + '].');
      if (atomic != null) migrated[atomicField] = atomic;
    }
    return migrated;
  });
}

export function buildAtomicMoneyPatch(kind: LegacyMoneyRecordKind, record: Record<string, unknown>): Record<string, unknown> {
  const currency = typeof record.currency === 'string' && record.currency.trim() ? record.currency : 'CKB';
  const set: Record<string, unknown> = {
    assetId: assetIdForLegacyCurrency(currency),
    moneyContractVersion: Number(PAYMENT_CONTRACT_VERSION.split('.')[0])
  };
  for (const [legacyField, atomicField] of TOP_LEVEL_FIELDS[kind]) {
    const atomic = migratedAtomicValue(record, legacyField, atomicField);
    if (atomic != null) set[atomicField] = atomic;
  }
  if (kind === 'session') {
    const logs = migrateArrayMoney(record.logs, [['amountMinor', 'amountAtomic']], 'logs');
    if (logs) set.logs = logs;
    const recipients = migrateArrayMoney(record.recipientWallets, [
      ['amountMinor', 'amountAtomic'],
      ['fiberLiquidityBridgeAmountMinor', 'fiberLiquidityBridgeAmountAtomic'],
      ['fiberLiquidityBridgeTopUpAmountMinor', 'fiberLiquidityBridgeTopUpAmountAtomic'],
      ['fiberChannelOpenAmountMinor', 'fiberChannelOpenAmountAtomic']
    ], 'recipientWallets');
    if (recipients) set.recipientWallets = recipients;
  }
  return set;
}

type MigratableModel = Model<unknown> & { collection: Model<unknown>['collection'] };

async function migrateModel(model: MigratableModel, kind: LegacyMoneyRecordKind): Promise<void> {
  const cursor = model.collection.find<Record<string, unknown>>({});
  for await (const record of cursor) {
    const patch = buildAtomicMoneyPatch(kind, record);
    await model.collection.updateOne({ _id: record._id as never }, { $set: patch });
  }
}

export async function migrateLegacyMoneyToAtomicStrings(): Promise<void> {
  const work: readonly [MigratableModel, LegacyMoneyRecordKind][] = [
    [WalletModel as unknown as MigratableModel, 'wallet'],
    [WalletFundingModel as unknown as MigratableModel, 'walletFunding'],
    [SessionModel as unknown as MigratableModel, 'session'],
    [ChargeAttemptModel as unknown as MigratableModel, 'chargeAttempt'],
    [ChargeDailyCounterModel as unknown as MigratableModel, 'dailyCounter'],
    [InvoiceModel as unknown as MigratableModel, 'invoice'],
    [PaymentJobModel as unknown as MigratableModel, 'paymentJob'],
    [PaymentBatchModel as unknown as MigratableModel, 'paymentBatch']
  ];
  for (const [model, kind] of work) await migrateModel(model, kind);
}
