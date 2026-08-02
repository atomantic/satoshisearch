/**
 * End-to-end tests for the native satoshi-grind backend (and JS fallback).
 * Skips the native suite when the binary is not built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hash160, bytesToHex } from '../src/lib/server/script.ts';
import { emptyMatchSet } from '../src/lib/server/grinder/matchset.ts';
import { GrinderPool } from '../src/lib/server/grinder/pool.ts';
import { nativeGrindAvailable, NativeGrindPool } from '../src/lib/server/grinder/native.ts';

function privFromInt(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function plantCompressed(set: ReturnType<typeof emptyMatchSet>, n: bigint) {
  const priv = privFromInt(n);
  const pub = secp256k1.ProjectivePoint.fromPrivateKey(priv).toRawBytes(true);
  set.hash160s.add(bytesToHex(hash160(pub)));
  set.size = set.hash160s.size + set.pubkeys.size;
  return priv;
}

function plantUncompressed(set: ReturnType<typeof emptyMatchSet>, n: bigint) {
  const priv = privFromInt(n);
  const pub = secp256k1.ProjectivePoint.fromPrivateKey(priv).toRawBytes(false);
  set.hash160s.add(bytesToHex(hash160(pub)));
  set.size = set.hash160s.size + set.pubkeys.size;
  return priv;
}

function plantPubkey(set: ReturnType<typeof emptyMatchSet>, n: bigint) {
  const priv = privFromInt(n);
  const pub = secp256k1.ProjectivePoint.fromPrivateKey(priv).toRawBytes(false);
  set.pubkeys.add(bytesToHex(pub));
  set.size = set.hash160s.size + set.pubkeys.size;
  return priv;
}

async function withPool(
  forceJs: boolean,
  set: ReturnType<typeof emptyMatchSet>,
  fn: (pool: GrinderPool) => Promise<void>
) {
  const prev = process.env.SATOSHI_GRIND_JS;
  if (forceJs) process.env.SATOSHI_GRIND_JS = '1';
  else delete process.env.SATOSHI_GRIND_JS;
  const pool = new GrinderPool();
  try {
    await pool.start(set);
    await fn(pool);
  } finally {
    await pool.stop();
    if (prev === undefined) delete process.env.SATOSHI_GRIND_JS;
    else process.env.SATOSHI_GRIND_JS = prev;
  }
}

test('JS backend finds compressed hash160 match', async () => {
  const set = emptyMatchSet();
  const priv = plantCompressed(set, 123456789n);
  await withPool(true, set, async (pool) => {
    assert.equal(pool.backendName, 'js');
    const r = await pool.run([{ priv, origin: 't:comp' }]);
    assert.equal(r.checked, 1);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].kind, 'hash160-compressed');
    assert.equal(r.matches[0].origin, 't:comp');
  });
});

test('JS backend finds uncompressed hash160 match', async () => {
  const set = emptyMatchSet();
  const priv = plantUncompressed(set, 987654321n);
  await withPool(true, set, async (pool) => {
    const r = await pool.run([{ priv, origin: 't:uncomp' }]);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].kind, 'hash160-uncompressed');
  });
});

test('JS backend finds raw P2PK pubkey match', async () => {
  const set = emptyMatchSet();
  const priv = plantPubkey(set, 555n);
  await withPool(true, set, async (pool) => {
    const r = await pool.run([{ priv, origin: 't:p2pk' }]);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].kind, 'pubkey');
  });
});

test('JS backend returns no match for miss', async () => {
  const set = emptyMatchSet();
  set.hash160s.add('00'.repeat(20));
  set.size = 1;
  await withPool(true, set, async (pool) => {
    const r = await pool.run([{ priv: privFromInt(42n), origin: 'miss' }]);
    assert.equal(r.checked, 1);
    assert.equal(r.matches.length, 0);
  });
});

const native = nativeGrindAvailable();

test(
  'native backend finds compressed + uncompressed + pubkey matches',
  { skip: !native },
  async () => {
    const set = emptyMatchSet();
    const p1 = plantCompressed(set, 111n);
    const p2 = plantUncompressed(set, 222n);
    const p3 = plantPubkey(set, 333n);

    const pool = new NativeGrindPool(2);
    await pool.start(set);
    try {
      assert.equal(pool.backend, 'native');
      const r = await pool.run([
        { priv: p1, origin: 'n:c' },
        { priv: p2, origin: 'n:u' },
        { priv: p3, origin: 'n:p' },
        { priv: privFromInt(999n), origin: 'n:miss' }
      ]);
      assert.equal(r.checked, 4);
      assert.equal(r.matches.length, 3);
      const kinds = new Set(r.matches.map((m) => m.kind));
      assert.ok(kinds.has('hash160-compressed'));
      assert.ok(kinds.has('hash160-uncompressed'));
      assert.ok(kinds.has('pubkey'));
      assert.ok(r.matches.every((m) => m.origin.startsWith('n:')));
    } finally {
      await pool.stop();
    }
  }
);

test('GrinderPool auto-selects native when available', { skip: !native }, async () => {
  const set = emptyMatchSet();
  plantCompressed(set, 7n);
  await withPool(false, set, async (pool) => {
    assert.equal(pool.backendName, 'native');
  });
});

test('JS range mode finds planted key', async () => {
  const set = emptyMatchSet();
  plantCompressed(set, 50n);
  await withPool(true, set, async (pool) => {
    const r = await pool.runRange({
      start: 40n,
      count: 20,
      originPrefix: 'puzzle8'
    });
    assert.ok(r.checked >= 1);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].kind, 'hash160-compressed');
    assert.match(r.matches[0].origin, /^puzzle8:0x32$/);
  });
});

test('native range mode finds planted key', { skip: !native }, async () => {
  const set = emptyMatchSet();
  plantCompressed(set, 42n);
  const pool = new NativeGrindPool(4);
  await pool.start(set);
  try {
    const r = await pool.runRange({ start: 1n, count: 100, originPrefix: 'lowentropy', originDecimal: true });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].origin, 'lowentropy:42');
    assert.equal(r.checked, 100);
  } finally {
    await pool.stop();
  }
});
