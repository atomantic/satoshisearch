import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { generateRescueWallet } from '../src/lib/server/bitcoin/wallet.ts';
import { decodeBitcoinAddress } from '../src/lib/server/script.ts';

test('generateRescueWallet produces a valid mnemonic and a matching mainnet p2wpkh address', () => {
  const wallet = generateRescueWallet();

  assert.equal(wallet.mnemonic.trim().split(/\s+/).length, 12);
  assert.equal(validateMnemonic(wallet.mnemonic, wordlist), true);

  const decoded = decodeBitcoinAddress(wallet.address);
  assert.ok(decoded);
  assert.equal(decoded?.type, 'p2wpkh');
  assert.equal(wallet.path, "m/84'/0'/0'/0/0");
});

test('generateRescueWallet is different on every call', () => {
  const a = generateRescueWallet();
  const b = generateRescueWallet();
  assert.notEqual(a.mnemonic, b.mnemonic);
  assert.notEqual(a.address, b.address);
});
