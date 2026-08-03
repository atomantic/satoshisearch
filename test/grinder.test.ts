import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hash160, bytesToHex } from '../src/lib/server/script.ts';
import { emptyMatchSet, matchCandidate } from '../src/lib/server/grinder/matchset.ts';
import { puzzleRangeSource, lowEntropySource } from '../src/lib/server/grinder/sources.ts';

function privFromInt(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

test('matches an injected key via its COMPRESSED hash160', () => {
  const priv = privFromInt(123456789n);
  const pub = secp256k1.ProjectivePoint.fromPrivateKey(priv).toRawBytes(true);
  const set = emptyMatchSet();
  set.hash160s.add(bytesToHex(hash160(pub)));
  const m = matchCandidate({ priv, origin: 'test' }, set);
  assert.ok(m, 'should match');
  assert.equal(m?.kind, 'hash160-compressed');
});

test('matches an injected key via its UNCOMPRESSED hash160 (the original bug)', () => {
  const priv = privFromInt(987654321n);
  const pub = secp256k1.ProjectivePoint.fromPrivateKey(priv).toRawBytes(false);
  const set = emptyMatchSet();
  set.hash160s.add(bytesToHex(hash160(pub)));
  const m = matchCandidate({ priv, origin: 'test' }, set);
  assert.ok(m, 'uncompressed keys must match — bitfinder missed these');
  assert.equal(m?.kind, 'hash160-uncompressed');
});

test('matches an injected key via a raw P2PK pubkey', () => {
  const priv = privFromInt(555n);
  const pub = secp256k1.ProjectivePoint.fromPrivateKey(priv).toRawBytes(false);
  const set = emptyMatchSet();
  set.pubkeys.add(bytesToHex(pub));
  const m = matchCandidate({ priv, origin: 'test' }, set);
  assert.ok(m);
  assert.equal(m?.kind, 'pubkey');
});

test('non-matching candidate returns null', () => {
  const set = emptyMatchSet();
  set.hash160s.add('00'.repeat(20));
  assert.equal(matchCandidate({ priv: privFromInt(42n), origin: 't' }, set), null);
});

test('lowEntropy source finds a planted small key end-to-end', () => {
  const target = 777n;
  const pub = secp256k1.ProjectivePoint.fromPrivateKey(privFromInt(target)).toRawBytes(true);
  const set = emptyMatchSet();
  set.hash160s.add(bytesToHex(hash160(pub)));

  const src = lowEntropySource(1000);
  let cursor = 0n;
  let found = null;
  for (let guard = 0; guard < 10; guard++) {
    const { items, nextCursor, done } = src.generate(cursor, 200);
    for (const c of items) {
      const m = matchCandidate(c, set);
      if (m) found = m;
    }
    cursor = nextCursor;
    if (done || found) break;
  }
  assert.ok(found, 'should find key 777 in the low-entropy space');
  assert.equal(found?.origin, 'lowentropy:777');
});

test('puzzle-range source yields keys inside [2^(n-1), 2^n)', () => {
  const src = puzzleRangeSource(8); // [128, 256)
  const { items } = src.generate(0n, 5);
  assert.equal(items.length, 5);
  const first = BigInt('0x' + Buffer.from(items[0].priv).toString('hex'));
  assert.equal(first, 128n);
});

