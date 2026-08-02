/**
 * BIP39 mnemonic → seed using Node's native OpenSSL PBKDF2.
 *
 * @scure/bip39's mnemonicToSeedSync is pure-JS HMAC and dominates ColdCard
 * expand time. BIP39 specifies PBKDF2-HMAC-SHA512, 2048 iterations, 64-byte
 * output, NFKD-normalized mnemonic + "mnemonic"+passphrase salt — identical
 * here, but backed by C.
 */
import { pbkdf2Sync } from 'node:crypto';

/** BIP39 seed from mnemonic (empty passphrase by default). */
export function mnemonicToSeedFast(mnemonic: string, passphrase = ''): Uint8Array {
  const password = mnemonic.normalize('NFKD');
  const salt = (`mnemonic${passphrase}`).normalize('NFKD');
  return new Uint8Array(pbkdf2Sync(password, salt, 2048, 64, 'sha512'));
}
