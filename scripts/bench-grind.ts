/**
 * Compare JS vs native grinder throughput (batch and range modes).
 *
 *   npx tsx scripts/bench-grind.ts
 *   npx tsx scripts/bench-grind.ts --keys 200000
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { hash160, bytesToHex } from '../src/lib/server/script.ts';
import { emptyMatchSet } from '../src/lib/server/grinder/matchset.ts';
import { GrinderPool } from '../src/lib/server/grinder/pool.ts';
import { nativeGrindAvailable } from '../src/lib/server/grinder/native.ts';
import { puzzleRangeSource, bigToPriv } from '../src/lib/server/grinder/sources.ts';
import { BATCH_JS, BATCH_NATIVE, BATCH_RANGE } from '../src/lib/server/grinder/engine.ts';
import { arg } from './_args.ts';

/** Mirrors engine.ts: native runs one unit at a time, so keep a short pipeline. */
const NATIVE_PIPELINE = 3;

function plant(set: ReturnType<typeof emptyMatchSet>, n: bigint) {
  const pub = secp256k1.ProjectivePoint.fromPrivateKey(bigToPriv(n)).toRawBytes(true);
  set.hash160s.add(bytesToHex(hash160(pub)));
  set.size = 1;
}

async function bench(
  label: string,
  forceJs: boolean,
  targetKeys: number,
  mode: 'batch' | 'range'
): Promise<void> {
  const prev = process.env.SATOSHI_GRIND_JS;
  if (forceJs) process.env.SATOSHI_GRIND_JS = '1';
  else delete process.env.SATOSHI_GRIND_JS;

  const set = emptyMatchSet();
  plant(set, 200n);

  const pool = new GrinderPool();
  await pool.start(set);

  const src = puzzleRangeSource(20);
  let cursor = 0n;
  let checked = 0;
  const t0 = performance.now();
  // Same batch/pipeline sizing the engine ships with, so the numbers below
  // describe the real configuration rather than a bench-only one.
  const batch =
    mode === 'range' ? BATCH_RANGE : pool.backendName === 'native' ? BATCH_NATIVE : BATCH_JS;
  const inflight: Promise<void>[] = [];
  const maxInflight = Math.max(2, pool.workerCount * 2);
  const maxIn = pool.backendName === 'native' ? Math.min(maxInflight, NATIVE_PIPELINE) : maxInflight;

  while (checked < targetKeys) {
    if (mode === 'range' && src.rangeBatch) {
      const { range, nextCursor } = src.rangeBatch(cursor, batch);
      cursor = nextCursor;
      if (!range?.count) break;
      const job = pool.runRange(range).then((r) => {
        checked += r.checked;
      });
      inflight.push(job);
    } else {
      const { items, nextCursor } = src.generate(cursor, batch);
      cursor = nextCursor;
      if (!items.length) break;
      const job = pool.run(items).then((r) => {
        checked += r.checked;
      });
      inflight.push(job);
    }
    if (inflight.length >= maxIn) await inflight.shift();
  }
  await Promise.all(inflight);
  const dt = (performance.now() - t0) / 1000;
  const rate = checked / dt;

  console.log(
    `${label.padEnd(14)} backend=${pool.backendName.padEnd(6)} workers=${String(pool.workerCount).padStart(2)} ` +
      `checked=${checked.toLocaleString()} time=${dt.toFixed(2)}s rate=${Math.round(rate).toLocaleString()} keys/s`
  );

  await pool.stop();
  if (prev === undefined) delete process.env.SATOSHI_GRIND_JS;
  else process.env.SATOSHI_GRIND_JS = prev;
}

const keysArg = arg(process.argv.slice(2), '--keys');
const keys = keysArg ? Number(keysArg) : 200_000;

console.log(`bench-grind: ${keys.toLocaleString()} keys per path\n`);
await bench('js-batch', true, keys, 'batch');
await bench('js-range', true, keys, 'range');
if (nativeGrindAvailable()) {
  await bench('native-batch', false, keys, 'batch');
  await bench('native-range', false, keys, 'range');
} else {
  console.log('native  (binary not found — run npm run grind:build)');
}
