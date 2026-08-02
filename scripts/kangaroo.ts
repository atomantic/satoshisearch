/**
 * CLI: run Pollard's kangaroo (cpu / jlp CUDA / external JSONL).
 *
 *   npm run kangaroo -- --selftest
 *   npm run kangaroo -- --puzzle 140
 *   npm run kangaroo -- --pubkey 02… --lo … --hi …
 *
 * Backend selection (env or Settings):
 *   KANGAROO_BACKEND=cpu|jlp|external
 *   KANGAROO_JLP_BIN=/path/to/kangaroo          # CUDA JeanLucPons build
 *   KANGAROO_JLP_GPU=1 KANGAROO_JLP_GPU_ID=0
 *   KANGAROO_EXTERNAL_CMD='./wrapper {pubkey} {lo} {hi}'
 */
import { openDb } from '../src/lib/server/db.ts';
import { effectiveKangaroo } from '../src/lib/server/settings.ts';
import { puzzleHalfBits } from '../src/lib/server/keyspace.ts';
import { kangaroo } from '../src/lib/server/grinder/kangaroo-engine.ts';
import {
  kangarooAvailability,
  runKangaroo
} from '../src/lib/server/grinder/kangaroo-backends.ts';
import { arg, has } from './_args.ts';

const argv = process.argv.slice(2);

if (has(argv, '--help') || has(argv, '-h')) {
  console.log(`Usage:
  npm run kangaroo -- --selftest
  npm run kangaroo -- --puzzle N            # records any hit via the rescue pipeline
  npm run kangaroo -- --pubkey HEX --lo HEX --hi HEX [--max-ops N] [--print-key]

Backends (KANGAROO_BACKEND):
  cpu       satoshi-kangaroo (default; npm run grind:build)
  jlp       JeanLucPons CUDA binary (KANGAROO_JLP_BIN, RTX 3090: ccap=86)
  external  command template emitting JSONL (KANGAROO_EXTERNAL_CMD)

See docs/KEYSPACE.md`);
  process.exit(0);
}

if (has(argv, '--selftest')) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('make', ['-C', 'native/grinder', 'selftest'], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const avail = kangarooAvailability();
const cfg = effectiveKangaroo();
console.error(`backend: ${avail.backend} (${cfg.source}) — ${avail.detail}`);

if (!avail.available) {
  console.error(`unavailable: ${avail.detail}`);
  if (cfg.backend === 'cpu') console.error('Build: npm run grind:build');
  if (cfg.backend === 'jlp') {
    console.error('Set KANGAROO_JLP_BIN to your CUDA Kangaroo binary.');
    console.error('Build JLP: make gpu=1 ccap=86 all   # 3090 = sm_86');
  }
  process.exit(1);
}

const progress = (ops: number, opsPerSec: number, dps: number) =>
  process.stderr.write(
    `\r  ${ops.toLocaleString()} ops  ${Math.round(opsPerSec).toLocaleString()} ops/s  dps=${dps}   `
  );

const puzzleArg = arg(argv, '--puzzle');
if (puzzleArg) {
  /*
   * Drive the engine rather than runKangaroo directly, so a hit takes the same
   * path as one found by the UI: encrypted to the vault, audited, filed as a
   * claim, handed to the sweeper. A key recovered here is never printed.
   *
   * The engine only lists exposed+funded puzzles, so query first to tell
   * "not indexed" apart from "sealed / no stored pubkey".
   */
  const n = Number(puzzleArg);
  const row = openDb()
    .prepare(
      `SELECT p.status, p.balance, t.pubkey, t.address
       FROM puzzle p JOIN target t ON t.id = p.target_id WHERE p.n = ?`
    )
    .get(n) as
    | { status: string; balance: number; pubkey: string | null; address: string }
    | undefined;
  if (!row) {
    console.error(`puzzle #${n} not indexed — run: npm run index:puzzles`);
    process.exit(1);
  }
  if (!row.pubkey) {
    console.error(
      `puzzle #${n} has no stored pubkey (status=${row.status}). Kangaroo needs an exposed key.`
    );
    process.exit(1);
  }
  console.error(`target: puzzle #${n} ${row.address} (${row.status}, ${row.balance} sats)`);
  console.error(`work:   ~2^${puzzleHalfBits(n)} group ops`);

  process.on('SIGINT', () => void kangaroo.stop());
  await kangaroo.start(n);
  while (kangaroo.status.running) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = kangaroo.status;
    progress(s.ops, s.opsPerSec, s.dps);
  }
  process.stderr.write('\n');

  const st = kangaroo.status;
  console.log(
    JSON.stringify(
      { puzzleN: n, backend: st.backend, result: st.lastResult, ops: st.ops, hits: st.hits },
      null,
      2
    )
  );
  process.exit(st.hits > 0 ? 0 : 1);
}

// Ad-hoc interval: no target row, so nothing to file a claim against.
const pubkey = arg(argv, '--pubkey');
const lo = arg(argv, '--lo');
const hi = arg(argv, '--hi');
if (!pubkey || !lo || !hi) {
  console.error('need --puzzle N  or  --pubkey --lo --hi');
  process.exit(2);
}

const { promise, cancel } = runKangaroo({
  pubkeyHex: pubkey,
  loHex: lo,
  hiHex: hi,
  maxOps: Number(arg(argv, '--max-ops') ?? 0) || undefined,
  onProgress: (p) => progress(p.ops, p.opsPerSec, p.dps)
});

process.on('SIGINT', () => cancel());

const res = await promise;
process.stderr.write('\n');

if (res.status === 'found') {
  // Keys land in shell history, scrollback and pm2 logs — opt in explicitly.
  const { privHex, ...rest } = res;
  console.log(
    JSON.stringify(
      { ok: true, backend: avail.backend, ...rest, ...(has(argv, '--print-key') ? { privHex } : {}) },
      null,
      2
    )
  );
  if (!has(argv, '--print-key')) {
    console.error('key withheld — pass --print-key to emit it, or use --puzzle N to file it.');
  }
  process.exit(0);
}
console.error(JSON.stringify({ backend: avail.backend, ...res }, null, 2));
process.exit(res.status === 'cancelled' ? 130 : 1);
