export const DEFAULT_CURRENCY = 'CKB';
export const MAX_ATOMIC_VALUE = (1n << 256n) - 1n;

declare const atomicAmountBrand: unique symbol;
export type AtomicAmount = string & { readonly [atomicAmountBrand]: true };

export interface CurrencyMetadata {
  code: string;
  decimals: number;
  symbol: string;
}

export const CURRENCY_METADATA: Record<string, CurrencyMetadata> = {
  BTC: { code: 'BTC', decimals: 11, symbol: 'BTC' },
  USDC: { code: 'USDC', decimals: 6, symbol: '$' },
  CKB: { code: 'CKB', decimals: 8, symbol: 'CKB' }
};

export function getCurrencyMetadata(currency: string = DEFAULT_CURRENCY): CurrencyMetadata {
  const metadata = CURRENCY_METADATA[currency.toUpperCase()];
  if (!metadata) throw new Error('Unsupported currency: ' + currency);
  return metadata;
}

function checkedAtomicValue(value: bigint): bigint {
  if (value < 0n) throw new Error('Atomic amount must be non-negative.');
  if (value > MAX_ATOMIC_VALUE) throw new Error('Atomic amount exceeds the 256-bit limit.');
  return value;
}

export function atomicAmountFromBigInt(value: bigint): AtomicAmount {
  return checkedAtomicValue(value).toString(10) as AtomicAmount;
}

export function parseAtomicAmount(value: unknown): bigint {
  if (typeof value !== 'string') {
    throw new Error('Atomic amount must be a base-10 integer string.');
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Atomic amount must be a canonical non-negative base-10 integer string.');
  }
  return checkedAtomicValue(BigInt(value));
}

export function asAtomicAmount(value: unknown): AtomicAmount {
  return atomicAmountFromBigInt(parseAtomicAmount(value));
}

export function legacyMinorToAtomicAmount(value: unknown, label = 'Legacy minor-unit amount'): AtomicAmount {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(label + ' must be a non-negative safe integer.');
  }
  return atomicAmountFromBigInt(BigInt(value as number));
}

export function atomicAmountToLegacySafeNumber(value: AtomicAmount): number {
  const parsed = parseAtomicAmount(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Atomic amount cannot be represented by the legacy numeric contract.');
  }
  return Number(parsed);
}

export function addAtomicAmounts(...values: readonly AtomicAmount[]): AtomicAmount {
  return atomicAmountFromBigInt(values.reduce((total, value) => total + parseAtomicAmount(value), 0n));
}

export function subtractAtomicAmounts(left: AtomicAmount, right: AtomicAmount): AtomicAmount {
  return atomicAmountFromBigInt(parseAtomicAmount(left) - parseAtomicAmount(right));
}

export function capAtomicAmount(value: AtomicAmount, maximum: AtomicAmount): AtomicAmount {
  return parseAtomicAmount(value) <= parseAtomicAmount(maximum) ? value : maximum;
}

export function formatAtomicAmount(value: AtomicAmount, decimals: number, options: { trimTrailingZeros?: boolean } = {}): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error('Asset decimals must be an integer between 0 and 30.');
  }
  const digits = parseAtomicAmount(value).toString(10);
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  let fraction = padded.slice(-decimals);
  if (options.trimTrailingZeros) fraction = fraction.replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : whole;
}

export function majorToAtomicAmount(value: number | string, currency: string = DEFAULT_CURRENCY): AtomicAmount {
  const { decimals } = getCurrencyMetadata(currency);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Money amount must be finite.');
  }
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error('Numeric money input exceeds the safe integer range; use a decimal string.');
  }
  const raw = typeof value === 'number' ? value.toString() : value.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('Money amount must be a non-negative decimal string.');
  }

  const [whole, fraction = ''] = raw.split('.');
  const extra = fraction.slice(decimals);
  if (extra.length > 0 && /[1-9]/.test(extra)) {
    throw new Error(currency + ' supports at most ' + decimals + ' decimal places.');
  }
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return atomicAmountFromBigInt(BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0'));
}

export function toMinorUnits(value: number | string, currency: string = DEFAULT_CURRENCY): number {
  return atomicAmountToLegacySafeNumber(majorToAtomicAmount(value, currency));
}

export function fromMinorUnits(minorUnits: number | undefined | null, currency: string = DEFAULT_CURRENCY): number {
  if (minorUnits == null) return 0;
  const atomic = legacyMinorToAtomicAmount(minorUnits, 'Minor-unit amount');
  return Number(formatAtomicAmount(atomic, getCurrencyMetadata(currency).decimals));
}

export function fallbackMinorUnits(minorUnits: number | undefined | null, majorAmount: number | undefined | null, currency: string = DEFAULT_CURRENCY): number {
  if (Number.isSafeInteger(minorUnits) && (minorUnits ?? 0) >= 0) return minorUnits as number;
  return toMinorUnits(String(majorAmount ?? 0), currency);
}

export function addMinorUnits(...values: number[]): number {
  return atomicAmountToLegacySafeNumber(addAtomicAmounts(...values.map((value) => legacyMinorToAtomicAmount(value))));
}

export function subtractMinorUnits(left: number, right: number): number {
  return atomicAmountToLegacySafeNumber(subtractAtomicAmounts(legacyMinorToAtomicAmount(left), legacyMinorToAtomicAmount(right)));
}

export function clampMinorUnits(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Minor-unit amount must be a safe integer.');
  return Math.max(0, value);
}

export function roundMoney(value: number): number {
  return fromMinorUnits(toMinorUnits(String(Math.max(0, value))));
}
