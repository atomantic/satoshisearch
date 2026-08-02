import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { mnemonicToSeedSync } from '@scure/bip39';
import { hash160, bytesToHex } from '../src/lib/server/script.ts';
import { emptyMatchSet, matchCandidate } from '../src/lib/server/grinder/matchset.ts';
import {
  Yasmarang,
  seedFrom,
  bcdTime,
  xorEntropy,
  SYSTICK_CARDINALITY
} from '../src/lib/server/grinder/yasmarang.ts';
import {
  coldcardSource,
  expandRngState,
  generateColdcardSeeds,
  describeRngSpace,
  decodeSeed,
  mk3ColdBootConfig,
  mk3KnownUidConfig,
  mk4ReseedConfig,
  padRangeConfig,
  demoColdcardConfig,
  DEFAULT_COLDCARD_CONFIG,
  type ColdcardConfig
} from '../src/lib/server/grinder/coldcard.ts';
import { mnemonicToSeedFast } from '../src/lib/server/grinder/bip39-seed.ts';
import { GrinderPool, coldcardWorkerCfg } from '../src/lib/server/grinder/pool.ts';
import { privToBig } from '../src/lib/server/grinder/sources.ts';

test('Yasmarang is deterministic and matches the locked vector', () => {
  const seed = seedFrom(0xdeadbeef, 0x00123456, bcdTime(12, 34, 56), 0x0155);
  const g = new Yasmarang(seed);
  const first = g.next();
  assert.equal(first.toString(16).padStart(8, '0'), 'c85aaef5');
  assert.equal(bytesToHex(new Yasmarang(seed).bytes(16)), 'f5ae5ac8e11db9349bd61f1f7d2ad2d4');
});

test('libngu XOR entropy is deterministic and differs from micropython-only', () => {
  const seed = seedFrom(0xdeadbeef, 1, 0, 0);
  const mp = new Yasmarang(seed).bytes(16);
  const xor = xorEntropy(seed, 16);
  assert.notEqual(bytesToHex(mp), bytesToHex(xor));
  assert.equal(bytesToHex(xorEntropy(seed, 16)), bytesToHex(xor));
});

test('native PBKDF2 matches @scure BIP39 seed', () => {
  const m = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const a = mnemonicToSeedFast(m);
  const b = mnemonicToSeedSync(m);
  assert.equal(bytesToHex(a), bytesToHex(b));
});

test('enumerator rediscovers a key planted from a specific seed state (end-to-end)', () => {
  const cfg: ColdcardConfig = {
    ...DEFAULT_COLDCARD_CONFIG,
    uids: [0xdeadbeef],
    systick: [0, 63],
    trValues: [bcdTime(9, 15, 30)],
    ssr: [0, 3]
  };
  const planted = expandRngState(cfg, decodeSeed(cfg, 20n)!);
  assert.ok(planted[0]);
  const pub = secp256k1.ProjectivePoint.fromPrivateKey(planted[0].priv).toRawBytes(true);
  const set = emptyMatchSet();
  set.hash160s.add(bytesToHex(hash160(pub)));

  const src = coldcardSource(cfg);
  let cursor = 0n;
  let found = null;
  for (let guard = 0; guard < 1000 && !found; guard++) {
    const { items, nextCursor, done } = src.generate(cursor, 40);
    for (const c of items) {
      const m = matchCandidate(c, set);
      if (m) found = m;
    }
    cursor = nextCursor;
    if (done) break;
  }
  assert.ok(found, 'enumerator should rediscover the planted ColdCard key');
  assert.match(found!.origin, /coldcard:pad=/);
});

test('generateColdcardSeeds is cheap and ordered', () => {
  const cfg: ColdcardConfig = {
    ...DEFAULT_COLDCARD_CONFIG,
    uids: [0xdeadbeef],
    systick: [0, 7],
    trValues: [bcdTime(9, 0, 0)],
    ssr: [0, 1]
  };
  const { seeds, nextCursor, done } = generateColdcardSeeds(cfg, 0n, 5);
  assert.equal(seeds.length, 5);
  assert.equal(nextCursor, 5n);
  assert.equal(done, false);
  assert.equal(seeds[0].pad, (0xdeadbeef ^ 0) >>> 0);
});

test('pool.runColdcard rediscovers planted key in workers', async () => {
  const cfg: ColdcardConfig = {
    ...DEFAULT_COLDCARD_CONFIG,
    uids: [0xdeadbeef],
    systick: [0, 31],
    trValues: [bcdTime(9, 15, 30)],
    ssr: [0, 1]
  };
  const planted = expandRngState(cfg, decodeSeed(cfg, 10n)!)[0];
  const pub = secp256k1.ProjectivePoint.fromPrivateKey(planted.priv).toRawBytes(true);
  const set = emptyMatchSet();
  set.hash160s.add(bytesToHex(hash160(pub)));
  set.size = 1;

  process.env.SATOSHI_GRIND_JS = '1';
  const pool = new GrinderPool();
  try {
    await pool.start(set);
    let cursor = 0n;
    let found = null;
    for (let guard = 0; guard < 20 && !found; guard++) {
      const { seeds, nextCursor, done } = generateColdcardSeeds(cfg, cursor, 4);
      cursor = nextCursor;
      if (!seeds.length) break;
      const r = await pool.runColdcard(coldcardWorkerCfg(cfg), seeds);
      if (r.matches.length) found = r.matches[0];
      if (done) break;
    }
    assert.ok(found, 'worker coldcard expand should rediscover planted key');
    assert.match(found!.origin, /coldcard:pad=/);
  } finally {
    await pool.stop();
    delete process.env.SATOSHI_GRIND_JS;
  }
});

test('coldcardSource attaches config for engine', () => {
  const cfg = { ...DEFAULT_COLDCARD_CONFIG, trValues: [bcdTime(0, 0, 0)] };
  const src = coldcardSource(cfg);
  assert.equal(src.coldcardConfig, cfg);
  assert.equal(src.bucket, 'coldcard');
  assert.equal(src.spaceKind, 'rng-states');
});

test('RNG space model counts seed states, not sequential key range', () => {
  const cfg: ColdcardConfig = {
    ...DEFAULT_COLDCARD_CONFIG,
    uids: [1, 2],
    systick: [0, 3],
    trValues: [bcdTime(0, 0, 0), bcdTime(0, 0, 1)],
    ssr: [0, 1],
    pathTemplates: ["m/84'/0'/0'/0"],
    addressGap: 3
  };
  const model = describeRngSpace(cfg);
  assert.equal(model.seedStates, 32n);
  assert.equal(model.keysPerSeed, 3);
  assert.equal(model.totalDerivedKeys, 96n);
  assert.ok(model.workBits > 4.9 && model.workBits < 5.1);
  const s0 = decodeSeed(cfg, 0n)!;
  const s1 = decodeSeed(cfg, 1n)!;
  const k0 = expandRngState(cfg, s0)[0].priv;
  const k1 = expandRngState(cfg, s1)[0].priv;
  assert.equal(k0.length, 32);
  assert.notDeepEqual(k0, k1);
  assert.notEqual(privToBig(k1) - privToBig(k0), 1n);
});

test('Mk3 cold-boot known UID is ~SysTick-only work', () => {
  const cfg = mk3ColdBootConfig(0x12345678);
  const m = describeRngSpace(cfg);
  assert.equal(cfg.deviceClass, 'mk3');
  assert.equal(cfg.enumMode, 'uid-systick');
  assert.equal(m.seedStates, BigInt(SYSTICK_CARDINALITY.mk3));
  assert.ok(m.workBits > 16.2 && m.workBits < 16.4);
  assert.deepEqual(cfg.trValues, [0]);
  assert.deepEqual(cfg.ssr, [0, 0]);
  // pad collapses uid⊕systick
  const s = decodeSeed(cfg, 1n)!;
  assert.equal(s.pad, (0x12345678 ^ 1) >>> 0);
  assert.equal(s.n, 0);
  assert.equal(s.d, 0);
});

test('pad mode does not multiply by independent SysTick', () => {
  const cfg = padRangeConfig([0, 255], { trValues: [0], ssr: [0, 0] });
  const m = describeRngSpace(cfg);
  assert.equal(cfg.enumMode, 'pad');
  assert.equal(m.seedStates, 256n);
  assert.equal(m.dimensions.length, 3);
  assert.equal(m.dimensions[0].name, 'pad');
});

test('Mk4 reseed mode enumerates only reseed word', () => {
  const cfg = mk4ReseedConfig([100, 109], { n: 7, d: 9 });
  const m = describeRngSpace(cfg);
  assert.equal(m.seedStates, 10n);
  assert.equal(cfg.enumMode, 'mk4-reseed');
  const s0 = decodeSeed(cfg, 0n)!;
  assert.equal(s0.pad, 100);
  assert.equal(s0.n, 7);
  assert.equal(s0.d, 9);
  const s9 = decodeSeed(cfg, 9n)!;
  assert.equal(s9.pad, 109);
  assert.equal(decodeSeed(cfg, 10n), null);
});

test('demo config stays micropython/no-sha256d for test vectors', () => {
  const d = demoColdcardConfig();
  assert.equal(d.entropyStream, 'micropython');
  assert.equal(d.sha256dEntropy, false);
  assert.ok(describeRngSpace(d).isDemoSlice);
});

test('mk3KnownUidConfig uses libngu-xor + sha256d by default', () => {
  const cfg = mk3KnownUidConfig(1, { coldBootRtc: true, systick: [0, 3] });
  assert.equal(cfg.entropyStream, 'libngu-xor');
  assert.equal(cfg.sha256dEntropy, true);
  // Expand still produces keys
  const k = expandRngState(cfg, decodeSeed(cfg, 0n)!);
  assert.ok(k.length >= 1);
});
