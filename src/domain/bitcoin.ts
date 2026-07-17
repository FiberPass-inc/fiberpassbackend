export const BITCOIN_NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'] as const;
export type BitcoinNetwork = (typeof BITCOIN_NETWORKS)[number];

export const BTCPAY_SCOPE_TYPES = ['wallet', 'pass', 'app'] as const;
export type BtcpayScopeType = (typeof BTCPAY_SCOPE_TYPES)[number];

export const BTCPAY_CONNECTION_STATUSES = ['active', 'revoked', 'failed'] as const;
export type BtcpayConnectionStatus = (typeof BTCPAY_CONNECTION_STATUSES)[number];

export const BTCPAY_INVOICE_STATUSES = ['new', 'processing', 'settled', 'expired', 'invalid'] as const;
export type BtcpayInvoiceStatus = (typeof BTCPAY_INVOICE_STATUSES)[number];

export const BTCPAY_PAYMENT_STATUSES = ['pending', 'uncertain', 'succeeded', 'failed'] as const;
export type BtcpayPaymentStatus = (typeof BTCPAY_PAYMENT_STATUSES)[number];

export const BITCOIN_PSBT_STATUSES = [
  'awaiting_signature',
  'broadcast',
  'confirming',
  'confirmed',
  'replaced',
  'abandoned',
  'failed'
] as const;
export type BitcoinPsbtStatus = (typeof BITCOIN_PSBT_STATUSES)[number];

export function requiredBtcpayPermissions(storeId: string): string[] {
  return [
    'btcpay.store.cancreateinvoice:' + storeId,
    'btcpay.store.canviewinvoices:' + storeId,
    'btcpay.store.canuselightningnode:' + storeId
  ];
}
