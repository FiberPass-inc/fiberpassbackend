import { createHash } from 'node:crypto';
import { address, networks, Psbt, type Network } from 'bitcoinjs-lib';
import type { BitcoinNetwork } from '../domain/bitcoin.js';
import { ApiError } from '../lib/errors.js';
import { asAtomicAmount, type AtomicAmount } from '../lib/money.js';

export const MSAT_PER_SAT = 1000n;
export const MSAT_PER_BTC = 100_000_000_000n;
const MAX_BITCOIN_MSAT = 21_000_000n * MSAT_PER_BTC;

export interface BitcoinDestination {
  address: string;
  scriptHex: string;
  amountAtomic?: AtomicAmount;
  label?: string;
  message?: string;
}

export function bitcoinJsNetwork(network: BitcoinNetwork): Network {
  if (network === 'mainnet') return networks.bitcoin;
  if (network === 'regtest') return networks.regtest;
  return networks.testnet;
}

export function parseBtcDecimalToMsat(raw: unknown, options: { onchain?: boolean; field?: string } = {}): AtomicAmount {
  const field = options.field ?? 'Bitcoin amount';
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new ApiError(400, 'BITCOIN_AMOUNT_INVALID', field + ' must be an exact decimal value.');
  }
  const value = String(raw).trim();
  const match = value.match(/^(0|[1-9]\d*)(?:\.(\d+))?$/);
  const maxDecimals = options.onchain ? 8 : 11;
  if (!match || (match[2]?.length ?? 0) > maxDecimals) {
    throw new ApiError(
      400,
      options.onchain ? 'BITCOIN_AMOUNT_NOT_SATOSHI_ALIGNED' : 'BITCOIN_AMOUNT_INVALID',
      options.onchain ? field + ' must resolve to a whole satoshi.' : field + ' has too many decimal places.'
    );
  }
  const fraction = (match[2] ?? '').padEnd(11, '0');
  const amount = BigInt(match[1]) * MSAT_PER_BTC + BigInt(fraction || '0');
  if (amount < 0n || amount > MAX_BITCOIN_MSAT) {
    throw new ApiError(400, 'BITCOIN_AMOUNT_INVALID', field + ' is outside the Bitcoin supply range.');
  }
  return asAtomicAmount(amount.toString(10));
}

export function formatMsatAsBtc(amountAtomic: string): string {
  const amount = BigInt(asAtomicAmount(amountAtomic));
  const whole = amount / MSAT_PER_BTC;
  const fraction = (amount % MSAT_PER_BTC).toString(10).padStart(11, '0').replace(/0+$/, '');
  return fraction ? whole.toString(10) + '.' + fraction : whole.toString(10);
}

export function msatToSats(amountAtomic: string, field = 'Bitcoin amount'): bigint {
  const amount = BigInt(asAtomicAmount(amountAtomic));
  if (amount % MSAT_PER_SAT !== 0n) {
    throw new ApiError(400, 'BITCOIN_AMOUNT_NOT_SATOSHI_ALIGNED', field + ' must resolve to a whole satoshi.');
  }
  return amount / MSAT_PER_SAT;
}

export function satsToMsat(satoshis: bigint): AtomicAmount {
  if (satoshis < 0n) throw new ApiError(400, 'BITCOIN_AMOUNT_INVALID', 'Satoshi amount cannot be negative.');
  return asAtomicAmount((satoshis * MSAT_PER_SAT).toString(10));
}

export function bitcoinAddressScript(value: string, network: BitcoinNetwork): Uint8Array {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /\s/.test(normalized)) {
    throw new ApiError(400, 'BITCOIN_ADDRESS_INVALID', 'Bitcoin address is invalid.');
  }
  try {
    return address.toOutputScript(normalized, bitcoinJsNetwork(network));
  } catch {
    throw new ApiError(400, 'BITCOIN_ADDRESS_NETWORK_MISMATCH', 'Bitcoin address is invalid or belongs to another network.');
  }
}

export function parseBitcoinDestination(input: {
  destination: string;
  network: BitcoinNetwork;
  expectedAmountAtomic?: string;
}): BitcoinDestination {
  const raw = input.destination.trim();
  if (!raw || raw.length > 2048) throw new ApiError(400, 'BITCOIN_DESTINATION_INVALID', 'Bitcoin destination is missing or too long.');

  let addressValue = raw;
  let amountAtomic: AtomicAmount | undefined;
  let label: string | undefined;
  let message: string | undefined;
  if (/^bitcoin:/i.test(raw)) {
    const match = raw.match(/^bitcoin:([^?]+)(?:\?(.*))?$/i);
    if (!match || match[1].startsWith('//')) throw new ApiError(400, 'BIP21_INVALID', 'BIP21 destination is invalid.');
    try {
      addressValue = decodeURIComponent(match[1]);
    } catch {
      throw new ApiError(400, 'BIP21_INVALID', 'BIP21 destination has invalid encoding.');
    }
    const query = new URLSearchParams(match[2] ?? '');
    if (query.getAll('amount').length > 1) throw new ApiError(400, 'BIP21_INVALID', 'BIP21 destination contains duplicate amounts.');
    for (const key of query.keys()) {
      if (key.toLowerCase().startsWith('req-')) {
        throw new ApiError(400, 'BIP21_REQUIRED_PARAMETER_UNSUPPORTED', 'BIP21 destination contains an unsupported required parameter.');
      }
    }
    const amount = query.get('amount');
    if (amount != null) amountAtomic = parseBtcDecimalToMsat(amount, { onchain: true, field: 'BIP21 amount' });
    label = query.get('label')?.trim().slice(0, 160) || undefined;
    message = query.get('message')?.trim().slice(0, 280) || undefined;
  }

  const script = bitcoinAddressScript(addressValue, input.network);
  const expected = input.expectedAmountAtomic == null ? undefined : asAtomicAmount(input.expectedAmountAtomic);
  if (amountAtomic && expected && BigInt(amountAtomic) !== BigInt(expected)) {
    throw new ApiError(400, 'BITCOIN_DESTINATION_AMOUNT_MISMATCH', 'BIP21 amount does not match the reviewed payment amount.');
  }
  if (expected) msatToSats(expected, 'Reviewed Bitcoin amount');
  return {
    address: addressValue,
    scriptHex: Buffer.from(script).toString('hex'),
    amountAtomic: amountAtomic ?? expected,
    label,
    message
  };
}

export function supportedFundingInputType(scriptHex: string): 'p2wpkh' | 'p2tr' {
  if (/^0014[0-9a-f]{40}$/i.test(scriptHex)) return 'p2wpkh';
  if (/^5120[0-9a-f]{64}$/i.test(scriptHex)) return 'p2tr';
  throw new ApiError(400, 'BITCOIN_INPUT_TYPE_UNSUPPORTED', 'Interactive PSBT funding currently requires native SegWit or Taproot inputs.');
}

export function psbtUnsignedFingerprint(psbt: Psbt): string {
  return createHash('sha256').update(psbt.data.globalMap.unsignedTx.toBuffer()).digest('hex');
}
