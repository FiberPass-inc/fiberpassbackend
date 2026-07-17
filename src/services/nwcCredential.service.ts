import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

function credentialKey(encoded = env.NWC_SECRET_ENCRYPTION_KEY): Buffer {
  const normalized = encoded.trim();
  const key = /^[a-f0-9]{64}$/i.test(normalized)
    ? Buffer.from(normalized, 'hex')
    : Buffer.from(normalized, 'base64');
  if (key.length !== 32) {
    throw new ApiError(503, 'NWC_ENCRYPTION_KEY_NOT_CONFIGURED', 'NWC connection storage requires a 32-byte hex or base64 encryption key.');
  }
  return key;
}

export function encryptNwcSecret(secret: Uint8Array, encodedKey?: string): string {
  if (secret.length !== 32) throw new ApiError(400, 'NWC_SECRET_INVALID', 'NWC connection secret must be 32 bytes.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialKey(encodedKey), iv);
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ['v1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function decryptNwcSecret(encrypted: string, encodedKey?: string): Uint8Array {
  const [version, ivText, cipherText, tagText] = encrypted.split('.');
  if (version !== 'v1' || !ivText || !cipherText || !tagText) {
    throw new ApiError(500, 'NWC_SECRET_INVALID', 'Stored NWC connection secret is invalid.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', credentialKey(encodedKey), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const secret = Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]);
    if (secret.length !== 32) throw new Error('invalid secret length');
    return Uint8Array.from(secret);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, 'NWC_SECRET_DECRYPTION_FAILED', 'Stored NWC connection secret could not be decrypted.');
  }
}
