import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

const ENC_PREFIX = 'enc:v1:';

/**
 * Mask a secret for API responses: keep last 4 chars when long enough.
 * Never returns the full secret.
 */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret) return '';
  if (secret.length <= 4) return '****';
  if (secret.length <= 8) return `****${secret.slice(-2)}`;
  return `****${secret.slice(-4)}`;
}

export function hasSecret(secret: string | null | undefined): boolean {
  return Boolean(secret && secret.trim().length > 0);
}

function deriveKey(passphrase: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(passphrase)) {
    return Buffer.from(passphrase, 'hex');
  }
  return scryptSync(passphrase, 'twinbot-model-secrets-v1', 32);
}

export function getSecretsKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.MODEL_SECRETS_KEY?.trim();
  if (!raw) return null;
  return deriveKey(raw);
}

/** Encrypt plaintext for at-rest storage. Returns plaintext unchanged when no key configured. */
export function encryptSecret(plaintext: string, key: Buffer | null): string {
  if (!key || !plaintext) return plaintext;
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

/** Decrypt at-rest secret. Passes through plaintext values that are not enc:v1. */
export function decryptSecret(stored: string, key: Buffer | null): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  if (!key) {
    throw new Error('MODEL_SECRETS_KEY is required to decrypt stored model API keys');
  }
  const payload = stored.slice(ENC_PREFIX.length);
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Corrupt encrypted secret');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

/** Stable fingerprint for change detection without exposing the key. */
export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}
