import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyScript,
  scriptHash,
  p2pkhAddress,
  decodeBase58Address,
  decodeBitcoinAddress,
  p2pkScript,
  p2pkhScript,
  p2wpkhScript,
  p2wpkhAddress,
  scriptForTarget,
  bytesToHex,
  hexToBytes
} from '../src/lib/server/script.ts';

// The block-9 coinbase: a 65-byte uncompressed P2PK output to Satoshi.
const BLK9_P2PK =
  '410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac';

test('classifies P2PK and derives a display address', () => {
  const c = classifyScript(BLK9_P2PK);
  assert.equal(c.type, 'p2pk');
  assert.equal(c.address, '12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S');
  assert.equal(c.pubkey?.length, 130); // 65 bytes uncompressed
});

test('scriptHash is forward sha256 (the /api/scripthash path param)', () => {
  // Verified end-to-end against the node: this hash returns the funded 18 BTC.
  // The JSON response echoes the REVERSED form — do not assert against that.
  assert.equal(
    scriptHash(BLK9_P2PK),
    '786929a9e558952ce72efc809ef12043c96978534ca2ccb7dda62d9b1be33181'
  );
});

test('P2PKH round-trips address <-> hash160', () => {
  const g = decodeBase58Address('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  assert.equal(g.version, 0);
  assert.equal(p2pkhAddress(g.hash), '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
});

test('classifies P2PKH', () => {
  const script = p2pkhScript(bytesToHex(decodeBase58Address('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa').hash));
  const c = classifyScript(script);
  assert.equal(c.type, 'p2pkh');
  assert.equal(c.address, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
});

test('p2pkScript builds a valid, re-classifiable P2PK script', () => {
  const pub = '0411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3';
  assert.equal(p2pkScript(pub), BLK9_P2PK);
});

// BIP-173 P2WPKH test vector
const P2WPKH_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const P2WPKH_H160 = '751e76e8199196d454941c45d1b3a323f1433bd6';

test('decodes P2WPKH bech32 to hash160', () => {
  const d = decodeBitcoinAddress(P2WPKH_ADDR);
  assert.ok(d);
  assert.equal(d?.type, 'p2wpkh');
  assert.equal(d?.hash160, P2WPKH_H160);
});

test('p2wpkhAddress / script round-trip', () => {
  const h = hexToBytes(P2WPKH_H160);
  assert.equal(p2wpkhAddress(h), P2WPKH_ADDR);
  const script = p2wpkhScript(P2WPKH_H160);
  assert.equal(script, `0014${P2WPKH_H160}`);
  const c = classifyScript(script);
  assert.equal(c.type, 'p2wpkh');
  assert.equal(c.hash160, P2WPKH_H160);
  assert.equal(c.address, P2WPKH_ADDR);
});

test('decodeBitcoinAddress keeps P2PKH and drops P2SH for single-key policy callers', () => {
  const p2pkh = decodeBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  assert.equal(p2pkh?.type, 'p2pkh');
  // Valid checksummed P2SH — type p2sh (callers skip for single-key match-set)
  const p2sh = decodeBitcoinAddress('3EExK1K1TF3v7zsFtQHt14XqexCwgmXM1y');
  assert.equal(p2sh?.type, 'p2sh');
});

test('scriptForTarget prefers script_hex then reconstructs by type', () => {
  assert.equal(
    scriptForTarget({ hash160: P2WPKH_H160, script_type: 'p2wpkh' }),
    p2wpkhScript(P2WPKH_H160)
  );
  assert.equal(
    scriptForTarget({ hash160: P2WPKH_H160, script_type: 'p2pkh' }),
    p2pkhScript(P2WPKH_H160)
  );
  assert.equal(scriptForTarget({ script_hex: '0014ab', hash160: '00' }), '0014ab');
});
