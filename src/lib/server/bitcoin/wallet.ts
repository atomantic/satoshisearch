/**
 * One-shot rescue wallet generation — a brand-new random mnemonic + native
 * segwit address for use as a rescue destination.
 *
 * The private key/mnemonic is never persisted anywhere: the app only ever
 * needs to know the destination *address* to sweep funds to it, so the
 * caller must surface the mnemonic to the operator exactly once and then
 * discard it.
 */
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { hash160, p2wpkhAddress } from '../script';

/** Native segwit, account 0, receive index 0. */
export const RESCUE_WALLET_PATH = "m/84'/0'/0'/0/0";

export interface GeneratedRescueWallet {
  mnemonic: string;
  path: string;
  address: string;
}

/** Generate a fresh 12-word mnemonic and derive its first receive address. */
export function generateRescueWallet(): GeneratedRescueWallet {
  const mnemonic = generateMnemonic(wordlist, 128);
  const seed = mnemonicToSeedSync(mnemonic);
  const child = HDKey.fromMasterSeed(seed).derive(RESCUE_WALLET_PATH);
  if (!child.publicKey) throw new Error('key derivation failed');
  return { mnemonic, path: RESCUE_WALLET_PATH, address: p2wpkhAddress(hash160(child.publicKey)) };
}
