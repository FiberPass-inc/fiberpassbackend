import { createHash } from 'node:crypto';
import * as bolt11 from 'bolt11';
import { getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import {
  NWC_INFO_KIND,
  isNwcMethod,
  type NwcEncryptionScheme,
  type NwcMethod,
  type NwcNetwork
} from '../domain/nwc.js';
import { ApiError } from '../lib/errors.js';
import { asAtomicAmount, parseAtomicAmount, type AtomicAmount } from '../lib/money.js';

const HEX_32 = /^[0-9a-f]{64}$/;
const MAX_CONNECTION_URI_LENGTH = 4096;
const MAX_INVOICE_LENGTH = 8192;

export interface ParsedNwcConnectionUri {
  walletPubkey: string;
  secret: Uint8Array;
  clientPubkey: string;
  relays: string[];
  lud16?: string;
}

export interface NwcInfo {
  eventId: string;
  walletPubkey: string;
  methods: NwcMethod[];
  advertisedMethods: string[];
  encryption: NwcEncryptionScheme;
  supportedEncryption: NwcEncryptionScheme[];
  notifications: string[];
}

export interface DecodedLightningInvoice {
  invoice: string;
  invoiceHash: string;
  paymentHash: string;
  network: NwcNetwork;
  amountAtomic: AtomicAmount;
  createdAt: string;
  expiresAt: string;
  payeeNodeKey: string;
}

interface Bolt11Network {
  bech32: string;
  pubKeyHash: number;
  scriptHash: number;
  validWitnessVersions: number[];
}

const BOLT11_NETWORKS: Record<NwcNetwork, Bolt11Network> = {
  mainnet: { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, validWitnessVersions: [0, 1] },
  testnet: { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
  signet: { bech32: 'tbs', pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
  regtest: { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] }
};

function parseRelay(value: string): string {
  let relay: URL;
  try {
    relay = new URL(value);
  } catch {
    throw new ApiError(400, 'NWC_RELAY_INVALID', 'NWC relay must be a valid WebSocket URL.');
  }
  if (!['wss:', 'ws:'].includes(relay.protocol) || relay.username || relay.password || relay.search || relay.hash) {
    throw new ApiError(400, 'NWC_RELAY_INVALID', 'NWC relay must be a credential-free WebSocket URL.');
  }
  relay.hostname = relay.hostname.toLowerCase();
  return relay.toString();
}

export function parseNwcConnectionUri(raw: string): ParsedNwcConnectionUri {
  const value = raw.trim();
  if (!value || value.length > MAX_CONNECTION_URI_LENGTH) {
    throw new ApiError(400, 'NWC_CONNECTION_URI_INVALID', 'NWC connection URI is missing or too long.');
  }

  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new ApiError(400, 'NWC_CONNECTION_URI_INVALID', 'NWC connection URI is invalid.');
  }
  if (uri.protocol !== 'nostr+walletconnect:' || uri.username || uri.password || uri.hash) {
    throw new ApiError(400, 'NWC_CONNECTION_URI_INVALID', 'NWC connection URI must use the NIP-47 scheme.');
  }

  const walletPubkey = uri.hostname.toLowerCase();
  const secrets = uri.searchParams.getAll('secret');
  const relayValues = uri.searchParams.getAll('relay');
  if (!HEX_32.test(walletPubkey) || secrets.length !== 1 || !HEX_32.test(secrets[0]?.toLowerCase() ?? '')) {
    throw new ApiError(400, 'NWC_CONNECTION_URI_INVALID', 'NWC connection URI has invalid connection keys.');
  }
  if (relayValues.length === 0 || relayValues.length > 5) {
    throw new ApiError(400, 'NWC_RELAY_REQUIRED', 'NWC connection URI must include one to five relays.');
  }

  const relays = [...new Set(relayValues.map(parseRelay))];
  const secret = Uint8Array.from(Buffer.from(secrets[0].toLowerCase(), 'hex'));
  let clientPubkey: string;
  try {
    clientPubkey = getPublicKey(secret);
  } catch {
    secret.fill(0);
    throw new ApiError(400, 'NWC_CONNECTION_URI_INVALID', 'NWC connection secret is not a valid Nostr key.');
  }

  const lud16 = uri.searchParams.get('lud16')?.trim();
  return {
    walletPubkey,
    secret,
    clientPubkey,
    relays,
    lud16: lud16 && lud16.length <= 254 ? lud16 : undefined
  };
}

function valuesFromTag(event: Event, name: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === name && typeof tag[1] === 'string')
    .flatMap((tag) => tag[1].split(/\s+/))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseNwcInfoEvent(event: Event, walletPubkey: string): NwcInfo {
  if (
    event.kind !== NWC_INFO_KIND
    || event.pubkey.toLowerCase() !== walletPubkey.toLowerCase()
    || !verifyEvent(event)
  ) {
    throw new ApiError(502, 'NWC_INFO_EVENT_INVALID', 'NWC wallet info event is invalid or unsigned.');
  }
  const advertisedMethods = [...new Set(event.content.split(/\s+/).map((value) => value.trim()).filter(Boolean))];
  if (advertisedMethods.length === 0 || advertisedMethods.some((method) => !/^[a-z][a-z0-9_]{0,63}$/.test(method))) {
    throw new ApiError(502, 'NWC_INFO_EVENT_INVALID', 'NWC wallet advertised invalid capabilities.');
  }
  const advertisedEncryption = valuesFromTag(event, 'encryption');
  const supportedEncryption = advertisedEncryption.length === 0
    ? ['nip04' as const]
    : advertisedEncryption.filter((value): value is NwcEncryptionScheme => value === 'nip44_v2' || value === 'nip04');
  if (supportedEncryption.length === 0) {
    throw new ApiError(409, 'NWC_ENCRYPTION_UNSUPPORTED', 'NWC wallet does not advertise a supported encryption scheme.');
  }
  return {
    eventId: event.id,
    walletPubkey: event.pubkey,
    methods: advertisedMethods.filter(isNwcMethod),
    advertisedMethods,
    encryption: supportedEncryption.includes('nip44_v2') ? 'nip44_v2' : 'nip04',
    supportedEncryption: [...new Set(supportedEncryption)],
    notifications: [...new Set(valuesFromTag(event, 'notifications'))]
  };
}

export function decodeLightningInvoice(input: {
  invoice: string;
  network: NwcNetwork;
  expectedAmountAtomic?: string;
  now?: Date;
}): DecodedLightningInvoice {
  const invoice = input.invoice.trim().toLowerCase();
  if (!invoice || invoice.length > MAX_INVOICE_LENGTH || /\s/.test(invoice)) {
    throw new ApiError(400, 'LIGHTNING_INVOICE_INVALID', 'Lightning invoice is invalid or too long.');
  }

  let decoded: ReturnType<typeof bolt11.decode>;
  try {
    decoded = bolt11.decode(invoice, BOLT11_NETWORKS[input.network]);
  } catch {
    throw new ApiError(400, 'LIGHTNING_INVOICE_INVALID', 'Lightning invoice is invalid or belongs to another network.');
  }
  if (!decoded.complete || !decoded.signature || !decoded.payeeNodeKey) {
    throw new ApiError(400, 'LIGHTNING_INVOICE_UNSIGNED', 'Lightning invoice must contain a valid payee signature.');
  }
  if (!decoded.millisatoshis || !/^[1-9]\d*$/.test(decoded.millisatoshis)) {
    throw new ApiError(400, 'LIGHTNING_INVOICE_AMOUNT_REQUIRED', 'Lightning invoice must encode a positive millisatoshi amount.');
  }
  const amountAtomic = asAtomicAmount(decoded.millisatoshis);
  if (input.expectedAmountAtomic && parseAtomicAmount(amountAtomic) !== parseAtomicAmount(input.expectedAmountAtomic)) {
    throw new ApiError(400, 'LIGHTNING_INVOICE_AMOUNT_MISMATCH', 'Lightning invoice amount does not match the payment intent.');
  }

  const paymentHash = decoded.tagsObject.payment_hash?.toLowerCase() ?? '';
  if (!HEX_32.test(paymentHash)) {
    throw new ApiError(400, 'LIGHTNING_INVOICE_PAYMENT_HASH_INVALID', 'Lightning invoice has no valid payment hash.');
  }
  const createdAtSeconds = decoded.timestamp ?? 0;
  const expiresAtSeconds = decoded.timeExpireDate ?? createdAtSeconds + 3600;
  if (createdAtSeconds <= 0 || expiresAtSeconds <= Math.floor((input.now ?? new Date()).getTime() / 1000)) {
    throw new ApiError(410, 'LIGHTNING_INVOICE_EXPIRED', 'Lightning invoice has expired.');
  }
  return {
    invoice,
    invoiceHash: createHash('sha256').update(invoice).digest('hex'),
    paymentHash,
    network: input.network,
    amountAtomic,
    createdAt: new Date(createdAtSeconds * 1000).toISOString(),
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    payeeNodeKey: decoded.payeeNodeKey
  };
}

export function verifyLightningPreimage(preimage: string, paymentHash: string): boolean {
  const normalized = preimage.trim().toLowerCase();
  return HEX_32.test(normalized)
    && createHash('sha256').update(Buffer.from(normalized, 'hex')).digest('hex') === paymentHash.toLowerCase();
}
