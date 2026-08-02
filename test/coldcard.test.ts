import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hash160, bytesToHex } from '../src/lib/server/script.ts';
import { emptyMatchSet, matchCandidate } from '../src/lib/server/grinder/matchset.ts';
import { Yasmarang, seedFrom, bcdTime } from '../src/lib/server/grinder/yasmarang.ts';
import { coldcardSource, keysForSeed, DEFAULT_COLDCARD_CONFIG, type ColdcardConfig } from '../src/lib/server/grinder/coldcard.ts';

test('Yasmarang is deterministic and matches the locked vector', () => {
  const seed = seedFrom(0xdeadbeef, 0x00123456, bcdTime(12, 34, 56), 0x0155);
  const g = new Yasmarang(seed);
  const first = g.next();
  assert.equal(first.toString(16).padStart(8, '0'), 'c85aaef5');
  // regression lock on the entropy stream
  assert.equal(bytesToHex(new Yasmarang(seed).bytes(16)), 'f5ae5ac8e11db9349bd61f1f7d2ad2d4');
});

test('enumerator rediscovers a key planted from a specific seed state (end-to-end)', () => {
  const cfg: ColdcardConfig = {
    ...DEFAULT_COLDCARD_CONFIG,
    uids: [0xdeadbeef],
    systick: [0, 63],
    trValues: [bcdTime(9, 15, 30)],
    ssr: [0, 3]
  };
  // Plant: the key at the 20th seed state, path m/84'/0'/0'/0/0.
  const planted = keysForSeed(cfg, decodeSeedForTest(cfg, 20))[0];
  const pub = secp256k1.ProjectivePoint.fromPrivateKey(planted.priv).toRawBytes(true);
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
  assert.match(found.origin, /coldcard:pad=/);
});

// mirror of coldcard.ts decodeSeed for the test's planting step
import { seedFrom as sf } from '../src/lib/server/grinder/yasmarang.ts';
function decodeSeedForTest(cfg: ColdcardConfig, idx: number) {
  const ssrs = cfg.ssr[1] - cfg.ssr[0] + 1;
  const systicks = cfg.systick[1] - cfg.systick[0] + 1;
  const trs = cfg.trValues.length;
  let r = idx;
  const ssrOff = r % ssrs; r = Math.floor(r / ssrs);
  const trI = r % trs; r = Math.floor(r / trs);
  const sysOff = r % systicks; r = Math.floor(r / systicks);
  const uidI = r % cfg.uids.length;
  return sf(cfg.uids[uidI], cfg.systick[0] + sysOff, cfg.trValues[trI], cfg.ssr[0] + ssrOff);
}
