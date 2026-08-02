/**
 * Key vault — encrypts recovered private keys at rest with AES-256-GCM. The
 * encryption key comes from VAULT_KEY_HEX (an Umbrel app secret / env var) and
 * is NEVER written to the database. Ciphertext is stored as
 * `iv:authTag:ciphertext` (all hex).
 *
 * If no vault key is configured, encryption fails closed: a recovered key is too
 * dangerous to persist in plaintext, so we refuse rather than degrade.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { effectiveVaultKeyHex } from '../settings';

function vaultKey(): Buffer {
  const hex = effectiveVaultKeyHex();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'No 32-byte vault key configured. Recovered keys cannot be stored safely. ' +
        'Generate one from Settings, or set VAULT_KEY_HEX: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

export function isVaultConfigured(): boolean {
  return /^[0-9a-fA-F]{64}$/.test(effectiveVaultKeyHex());
}

/** Encrypt a private key hex string → `iv:tag:ct` hex triple. */
export function encryptKey(privHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', vaultKey(), iv);
  const ct = Buffer.concat([cipher.update(privHex, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/** Decrypt an `iv:tag:ct` triple back to the private key hex. */
export function decryptKey(blob: string): string {
  const [ivHex, tagHex, ctHex] = blob.split(':');
  if (!ivHex || !tagHex || !ctHex) throw new Error('malformed vault blob');
  const decipher = createDecipheriv('aes-256-gcm', vaultKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}
