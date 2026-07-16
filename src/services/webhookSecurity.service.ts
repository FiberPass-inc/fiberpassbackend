import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

interface LookupAddress {
  address: string;
  family: number;
}

export type WebhookDnsLookup = (hostname: string) => Promise<readonly LookupAddress[]>;

export interface ResolvedWebhookDestination {
  url: URL;
  address: string;
  family: number;
}

const defaultLookup: WebhookDnsLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

function ipv4Number(address: string): number | undefined {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function inIpv4Cidr(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function forbiddenIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value == null) return true;
  const ranges: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ];
  return ranges.some(([base, prefix]) => inIpv4Cidr(value, ipv4Number(base) ?? 0, prefix));
}

export function isForbiddenWebhookAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const family = isIP(normalized);
  if (family === 4) return forbiddenIpv4(normalized);
  if (family !== 6) return true;

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return forbiddenIpv4(mapped);
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:');
}

export async function resolveWebhookDestination(rawUrl: string, dnsLookup: WebhookDnsLookup = defaultLookup): Promise<ResolvedWebhookDestination> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'WEBHOOK_URL_INVALID', 'Webhook URL must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:') {
    throw new ApiError(400, 'WEBHOOK_HTTPS_REQUIRED', 'Webhook URLs must use HTTPS.');
  }
  if (url.username || url.password) {
    throw new ApiError(400, 'WEBHOOK_URL_CREDENTIALS_FORBIDDEN', 'Webhook URLs cannot contain embedded credentials.');
  }
  if (url.port && url.port !== '443') {
    throw new ApiError(400, 'WEBHOOK_PORT_FORBIDDEN', 'Webhook URLs must use HTTPS port 443.');
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname === 'metadata.google.internal'
  ) {
    throw new ApiError(400, 'WEBHOOK_DESTINATION_FORBIDDEN', 'Webhook destination resolves to a non-public network.');
  }

  let addresses: readonly LookupAddress[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await dnsLookup(hostname);
  } catch {
    throw new ApiError(400, 'WEBHOOK_DNS_LOOKUP_FAILED', 'Webhook destination DNS lookup failed.');
  }
  if (addresses.length === 0) {
    throw new ApiError(400, 'WEBHOOK_DNS_LOOKUP_FAILED', 'Webhook destination did not resolve to an address.');
  }
  if (addresses.some((entry) => isForbiddenWebhookAddress(entry.address))) {
    throw new ApiError(400, 'WEBHOOK_DESTINATION_FORBIDDEN', 'Webhook destination resolves to a non-public network.');
  }

  url.hash = '';
  return { url, address: addresses[0].address, family: addresses[0].family };
}

function encryptionKey(encoded = env.WEBHOOK_SECRET_ENCRYPTION_KEY): Buffer {
  const normalized = encoded.trim();
  const key = /^[a-f0-9]{64}$/i.test(normalized)
    ? Buffer.from(normalized, 'hex')
    : Buffer.from(normalized, 'base64');
  if (key.length !== 32) {
    throw new ApiError(503, 'WEBHOOK_ENCRYPTION_KEY_NOT_CONFIGURED', 'Webhook secret encryption requires a 32-byte hex or base64 key.');
  }
  return key;
}

export function encryptWebhookSecret(secret: string, encodedKey?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(encodedKey), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function decryptWebhookSecret(encrypted: string, encodedKey?: string): string {
  const [version, ivText, cipherText, tagText] = encrypted.split('.');
  if (version !== 'v1' || !ivText || !cipherText || !tagText) {
    throw new ApiError(500, 'WEBHOOK_SECRET_INVALID', 'Stored webhook signing secret is invalid.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(encodedKey), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, 'WEBHOOK_SECRET_DECRYPTION_FAILED', 'Stored webhook signing secret could not be decrypted.');
  }
}
