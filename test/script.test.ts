import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyScript,
  scriptHash,
  p2pkhAddress,
  decodeBase58Address,
  p2pkScript,
  p2pkhScript,
  bytesToHex
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
