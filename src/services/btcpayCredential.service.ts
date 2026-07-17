import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

function credentialKey(encoded = env.BTCPAY_SECRET_ENCRYPTION_KEY): Buffer {
  const normalized = encoded.trim();
  const key = /^[a-f0-9]{64}$/i.test(normalized)
    ? Buffer.from(normalized, 'hex')
    : Buffer.from(normalized, 'base64');
  if (key.length !== 32) {
    throw new ApiError(503, 'BTCPAY_ENCRYPTION_KEY_NOT_CONFIGURED', 'BTCPay credential storage requires a 32-byte hex or base64 key.');
  }
  return key;
}

export function encryptBtcpayApiKey(apiKey: string, encodedKey?: string): string {
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(apiKey)) throw new ApiError(400, 'BTCPAY_API_KEY_INVALID', 'BTCPay API key format is invalid.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialKey(encodedKey), iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function decryptBtcpayApiKey(encrypted: string, encodedKey?: string): string {
  const [version, ivText, cipherText, tagText] = encrypted.split('.');
  if (version !== 'v1' || !ivText || !cipherText || !tagText) {
    throw new ApiError(500, 'BTCPAY_CREDENTIAL_INVALID', 'Stored BTCPay credential is invalid.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', credentialKey(encodedKey), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const value = Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]).toString('utf8');
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(value)) throw new Error('invalid key');
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, 'BTCPAY_CREDENTIAL_DECRYPTION_FAILED', 'Stored BTCPay credential could not be decrypted.');
  }
}
