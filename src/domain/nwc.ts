export const NWC_METHODS = [
  'get_info',
  'get_balance',
  'pay_invoice',
  'lookup_invoice',
  'list_transactions'
] as const;

export type NwcMethod = (typeof NWC_METHODS)[number];

export const NWC_NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'] as const;
export type NwcNetwork = (typeof NWC_NETWORKS)[number];

export const NWC_SCOPE_TYPES = ['wallet', 'pass', 'app'] as const;
export type NwcScopeType = (typeof NWC_SCOPE_TYPES)[number];

export const NWC_EXECUTION_MODES = ['interactive', 'unattended'] as const;
export type NwcExecutionMode = (typeof NWC_EXECUTION_MODES)[number];

export const NWC_ENCRYPTION_SCHEMES = ['nip44_v2', 'nip04'] as const;
export type NwcEncryptionScheme = (typeof NWC_ENCRYPTION_SCHEMES)[number];

export const NWC_CONNECTION_STATUSES = ['active', 'revoked', 'failed'] as const;
export type NwcConnectionStatus = (typeof NWC_CONNECTION_STATUSES)[number];

export const NWC_PAYMENT_STATUSES = ['pending', 'uncertain', 'succeeded', 'failed'] as const;
export type NwcPaymentStatus = (typeof NWC_PAYMENT_STATUSES)[number];

export const NWC_INFO_KIND = 13194;
export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;

export function isNwcMethod(value: string): value is NwcMethod {
  return (NWC_METHODS as readonly string[]).includes(value);
}
