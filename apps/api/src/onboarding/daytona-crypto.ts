import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config';

const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;
const HKDF_INFO = Buffer.from('kortix-user-daytona-api-key-v1', 'utf8');

export interface EncryptedDaytonaKey {
  encryptedApiKey: string;
  encryptionIv: string;
  encryptionTag: string;
}

function deriveKey(scopeId: string): Buffer {
  const master = config.DAYTONA_CREDENTIALS_ENCRYPTION_KEY || config.API_KEY_SECRET;
  if (!master) {
    throw new Error('DAYTONA_CREDENTIALS_ENCRYPTION_KEY or API_KEY_SECRET must be set to encrypt Daytona API keys');
  }
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(master, 'utf8'), Buffer.from(scopeId, 'utf8'), HKDF_INFO, 32),
  );
}

/**
 * Encrypt a plaintext Daytona API key (`dtn_...`) using AES-256-GCM with a
 * per-scope HKDF-SHA256 derived key.
 */
export function encryptDaytonaApiKey(scopeId: string, plaintextApiKey: string): EncryptedDaytonaKey {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(scopeId), iv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintextApiKey, 'utf8'), cipher.final()]);
  return {
    encryptedApiKey: ciphertext.toString('base64url'),
    encryptionIv: iv.toString('base64url'),
    encryptionTag: cipher.getAuthTag().toString('base64url'),
  };
}

/**
 * Decrypt a stored Daytona API key using AES-256-GCM.
 */
export function decryptDaytonaApiKey(scopeId: string, enc: EncryptedDaytonaKey): string {
  const iv = Buffer.from(enc.encryptionIv, 'base64url');
  const tag = Buffer.from(enc.encryptionTag, 'base64url');
  const ciphertext = Buffer.from(enc.encryptedApiKey, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(scopeId), iv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
