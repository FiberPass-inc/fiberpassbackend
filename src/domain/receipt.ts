import { createHash } from 'node:crypto';

export const RECEIPT_SOURCE_TYPES = ['scheduled_occurrence', 'usage_event', 'charge_attempt'] as const;
export type ReceiptSourceType = (typeof RECEIPT_SOURCE_TYPES)[number];

export const RECEIPT_STATUSES = ['succeeded', 'failed', 'refunded'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const NOTIFICATION_DELIVERY_STATUSES = [
  'queued',
  'delivering',
  'retrying',
  'succeeded',
  'failed',
  'cancelled'
] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

export interface ReceiptHashInput {
  version: 1;
  receiptId: string;
  ownerWalletId: string;
  recipientId?: string;
  sourceType: ReceiptSourceType;
  sourceId: string;
  settlementId: string;
  rail: string;
  network: string;
  assetId: string;
  amountAtomic: string;
  feeAtomic: string;
  feeKnown: boolean;
  status: ReceiptStatus;
  paymentHash?: string;
  proofKind?: string;
  proofReference?: string;
  settledAt: Date;
}

export function hashReceipt(input: ReceiptHashInput): string {
  const canonical = [
    input.version,
    input.receiptId,
    input.ownerWalletId,
    input.recipientId ?? null,
    input.sourceType,
    input.sourceId,
    input.settlementId,
    input.rail,
    input.network,
    input.assetId,
    input.amountAtomic,
    input.feeAtomic,
    input.feeKnown,
    input.status,
    input.paymentHash ?? null,
    input.proofKind ?? null,
    input.proofReference ?? null,
    input.settledAt.toISOString()
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function allocateAtomicFee(totalFeeAtomic: string, amountAtomics: readonly string[]): string[] {
  if (!/^\d+$/.test(totalFeeAtomic) || amountAtomics.some((amount) => !/^\d+$/.test(amount))) {
    throw new Error('Receipt fee allocation requires unsigned atomic-unit integer strings.');
  }
  if (amountAtomics.length === 0) return [];
  const totalFee = BigInt(totalFeeAtomic);
  const amounts = amountAtomics.map(BigInt);
  const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
  if (totalAmount <= 0n) throw new Error('Receipt fee allocation requires a positive settlement total.');
  const shares = amounts.map((amount) => (totalFee * amount) / totalAmount);
  let remainder = totalFee - shares.reduce((sum, share) => sum + share, 0n);
  for (let index = 0; remainder > 0n; index = (index + 1) % shares.length) {
    shares[index] += 1n;
    remainder -= 1n;
  }
  return shares.map(String);
}
