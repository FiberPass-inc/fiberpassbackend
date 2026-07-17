import { asAtomicAmount, type AtomicAmount } from '../lib/money.js';

export const PAYMENT_CONTRACT_VERSION = '2.0' as const;

declare const assetIdBrand: unique symbol;
export type AssetId = string & { readonly [assetIdBrand]: true };

export const PAYMENT_RAILS = ['lightning', 'bitcoin_onchain', 'fiber', 'ckb_onchain'] as const;
export type PaymentRail = (typeof PAYMENT_RAILS)[number];

export const PAYMENT_STATUSES = ['created', 'quoted', 'pending', 'uncertain', 'succeeded', 'failed', 'cancelled', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_DESTINATION_KINDS = ['address', 'invoice', 'offer', 'endpoint', 'psbt_output'] as const;
export type PaymentDestinationKind = (typeof PAYMENT_DESTINATION_KINDS)[number];

export const PAYMENT_PROOF_KINDS = ['transaction', 'payment_hash', 'connector_receipt', 'refund'] as const;
export type PaymentProofKind = (typeof PAYMENT_PROOF_KINDS)[number];

export interface MoneyValue {
  assetId: AssetId;
  amountAtomic: AtomicAmount;
}

export interface PaymentDestination {
  kind: PaymentDestinationKind;
  rail: PaymentRail;
  network: string;
  value: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface PaymentProof {
  kind: PaymentProofKind;
  reference: string;
  network?: string;
  observedAt: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface PaymentIntent {
  intentId: string;
  idempotencyKey: string;
  rail: PaymentRail;
  network: string;
  money: MoneyValue;
  destination: PaymentDestination;
  description?: string;
  expiresAt?: string;
}

export interface PaymentQuote {
  quoteId: string;
  intentId: string;
  connectorId: string;
  amount: MoneyValue;
  fee: MoneyValue;
  total: MoneyValue;
  expiresAt: string;
}

export interface PaymentResult {
  intentId: string;
  status: PaymentStatus;
  amount: MoneyValue;
  connectorId: string;
  connectorReference?: string;
  proof?: PaymentProof;
  failureCode?: string;
  failureMessage?: string;
  updatedAt: string;
}

export function asAssetId(value: unknown): AssetId {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('Asset id must use the canonical namespace:reference form.');
  }
  return value as AssetId;
}

export function assetIdForLegacyCurrency(currency: string): AssetId {
  const normalized = currency.trim().toUpperCase();
  if (normalized === 'CKB') return asAssetId('ckb:ckb');
  if (normalized === 'BTC') return asAssetId('bitcoin:btc');
  return asAssetId('legacy:' + normalized.toLowerCase());
}

export function moneyValue(assetId: unknown, amountAtomic: unknown): MoneyValue {
  return { assetId: asAssetId(assetId), amountAtomic: asAtomicAmount(amountAtomic) };
}
