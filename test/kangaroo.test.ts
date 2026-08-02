/**
 * Native Pollard's kangaroo — selftest + small known-key solve via the binary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '../src/lib/server/script.ts';
import { bigToPriv } from '../src/lib/server/grinder/sources.ts';
import {
  kangarooAvailable,
  runKangaroo
} from '../src/lib/server/grinder/kangaroo-backends.ts';

const bin = join(process.cwd(), 'native/grinder/satoshi-kangaroo');

test('satoshi-kangaroo binary builds and selftests', (t) => {
  if (!existsSync(bin)) {
    return t.skip('satoshi-kangaroo not built — run npm run grind:build');
  }
  const r = spawnSync(bin, ['--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stderr, /all \d+ cases passed/);
});

test('runKangaroo recovers a known key in a small interval', async (t) => {
  if (!kangarooAvailable()) {
    return t.skip('kangaroo backend not available');
  }
  // Force CPU path for unit test (JLP may be configured on GPU boxes).
  process.env.KANGAROO_BACKEND = 'cpu';

  const k = 0x2a3b4cn;
  const lo = 0x200000n;
  const hi = 0x300000n;
  const priv = bigToPriv(k);
  const pub = secp256k1.getPublicKey(priv, true);
  const pubkeyHex = bytesToHex(pub);

  const { promise } = runKangaroo({
    pubkeyHex,
    loHex: lo.toString(16),
    hiHex: hi.toString(16),
    threads: 2,
    dpBits: 4,
    maxOps: 20_000_000
  });

  const res = await promise;
  assert.equal(res.status, 'found', JSON.stringify(res));
  if (res.status === 'found') {
    assert.equal(res.privHex.toLowerCase(), bytesToHex(priv).toLowerCase());
  }
});
