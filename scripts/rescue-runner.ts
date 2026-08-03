#!/usr/bin/env tsx
/**
 * Realtime rescue runner — long-lived process for weak-key races.
 *
 * Usage:
 *   npx tsx scripts/rescue-runner.ts check
 *   npx tsx scripts/rescue-runner.ts run --source coldcard
 *   npx tsx scripts/rescue-runner.ts run --source coldcard --require-live
 *   npx tsx scripts/rescue-runner.ts run --source puzzle-71 --refresh-hours 12
 *
 * Does not replace the web UI; shares DATA_DIR SQLite for hits/audit/match-set.
 * Start the UI separately for monitoring, or tail RESCUE_NOTIFY_FILE / webhook.
 *
 * Policy remains enforced by the sweeper — this only keeps grind + readiness alive.
 */
import { spawn } from 'node:child_process';
import { assessRescueReadiness, formatReadiness } from '../src/lib/server/rescue/readiness.ts';
import { notifyRescue } from '../src/lib/server/rescue/notify.ts';
import { grinder, lastGrindCursor } from '../src/lib/server/grinder/engine.ts';
import { makeSource, listSources } from '../src/lib/server/grinder/registry.ts';
import {
  parseShardToken,
  isWindowSpecified,
  type WindowSpec
} from '../src/lib/server/grinder/range-window.ts';

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('-')) return process.argv[i + 1];
  return dflt;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

/**
 * Exit code for intentional completion (space exhausted, clean stop).
 * Must be non-zero: some PM2 versions coerce `stop_exit_codes: [0]` to the
 * number `0`, which is falsy and never disables autorestart. 75 = EX_TEMPFAIL
 * is unused here as a crash code; ecosystem maps it in stop_exit_codes.
 */
const EXIT_DONE = 75;

function usage(): never {
  console.log(`Usage:
  rescue-runner check [--bucket coldcard]
  rescue-runner run --source <id> [options]

Sources: ${listSources()
    .map((s) => s.id)
    .join(' | ')} | puzzle-<n>

Options:
  --bucket <name>       Policy bucket for readiness (default: source bucket / coldcard)
  --require-live        Abort unless live auto-sweep is fully armed
  --require-dry-run     Abort unless dry-run sweep path is ready (dest + bucket + vault warn ok)
  --refresh-hours <n>   Re-run richlist:refresh when snapshot older than n hours (0=never)
  --status-sec <n>      Status print interval (default 15)
  --resume              Resume from last DB cursor for this source name

Puzzle-range windows (multi-machine farm; only with --source puzzle-N):
  --start-pct <0-100>   Skip this percent of the full puzzle range
  --end-pct <0-100>     Stop at this percent of the full puzzle range
  --start-hex <hex>     Absolute start private key (inclusive)
  --end-hex <hex>       Absolute end private key (exclusive)
  --shard <i/n>         Contiguous slab i of n (e.g. 0/4 on host A, 1/4 on B, …)
`);
  process.exit(1);
}

async function refreshRichlist(): Promise<void> {
  console.log('[runner] refreshing richlist (loyce fetch + import)…');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', 'richlist:refresh'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`richlist:refresh exit ${code}`))));
  });
}

async function cmdCheck(bucket: string): Promise<void> {
  const r = assessRescueReadiness({ primaryBucket: bucket });
  console.log(formatReadiness(r));
  process.exit(r.canGrind ? 0 : 2);
}

function windowFromArgs(): WindowSpec | null {
  const startHex = arg('--start-hex') ?? null;
  const endHex = arg('--end-hex') ?? null;
  const startPctRaw = arg('--start-pct');
  const endPctRaw = arg('--end-pct');
  const startPct = startPctRaw != null ? Number(startPctRaw) : null;
  const endPct = endPctRaw != null ? Number(endPctRaw) : null;
  const shard = parseShardToken(arg('--shard'));
  const spec: WindowSpec = {
    startHex,
    endHex,
    startPct: startPct != null && Number.isFinite(startPct) ? startPct : null,
    endPct: endPct != null && Number.isFinite(endPct) ? endPct : null,
    shardIndex: shard?.shardIndex ?? null,
    shardCount: shard?.shardCount ?? null
  };
  return isWindowSpecified(spec) ? spec : null;
}

async function cmdRun(): Promise<void> {
  const sourceId = arg('--source');
  if (!sourceId) usage();

  const window = windowFromArgs();
  let source;
  try {
    source = makeSource(sourceId!, window);
  } catch (e) {
    console.error(String(e));
    process.exit(1);
  }
  if (!source) {
    console.error(`Unknown or unavailable source: ${sourceId}`);
    process.exit(1);
  }

  const bucket = arg('--bucket', source.bucket) ?? source.bucket;
  const requireLive = hasFlag('--require-live');
  const requireDry = hasFlag('--require-dry-run');
  const refreshHours = Number(arg('--refresh-hours', '0') ?? '0');
  const statusSec = Number(arg('--status-sec', '15') ?? '15');
  const resume = hasFlag('--resume');

  let readiness = assessRescueReadiness({ primaryBucket: bucket });
  console.log(formatReadiness(readiness));
  console.log('');

  if (!readiness.canGrind) {
    console.error('[runner] cannot grind — fix FAIL items above');
    process.exit(2);
  }
  if (requireLive && !readiness.canLiveSweep) {
    console.error('[runner] --require-live but live sweep not armed');
    process.exit(2);
  }
  if (requireDry && !readiness.canDryRunSweep) {
    console.error('[runner] --require-dry-run but dry-run sweep path incomplete');
    process.exit(2);
  }

  if (refreshHours > 0) {
    const age = readiness.richlistAgeHours;
    if (age === null || age > refreshHours) {
      try {
        await refreshRichlist();
        readiness = assessRescueReadiness({ primaryBucket: bucket });
        console.log('[runner] match-set after refresh:', readiness.matchSetSize);
      } catch (e) {
        console.error('[runner] richlist refresh failed:', e);
        if (readiness.matchSetSize === 0) process.exit(2);
        console.error('[runner] continuing with existing match-set');
      }
    }
  }

  const cursor = resume ? lastGrindCursor(source.name) : 0n;
  const spaceSize = source.size;

  // Finite sources (e.g. coldcard demo slice): resume past the end means the
  // space is already fully ground. Exit EXIT_DONE so PM2 stop_exit_codes does not thrash.
  if (spaceSize != null && cursor >= spaceSize) {
    console.log(
      `[runner] space exhausted — source=${source.name} cursor=${cursor} size=${spaceSize} (nothing left to grind)`
    );
    console.log(
      '[runner] re-run without --resume to restart from 0, or pick a larger source / device model'
    );
    process.exit(EXIT_DONE);
  }

  console.log(
    `[runner] starting source=${source.name} bucket=${source.bucket} spaceBits=${source.spaceBits.toFixed(1)} cursor=${cursor}${spaceSize != null ? `/${spaceSize}` : ''} resume=${resume}${window ? ` window=${JSON.stringify(window)}` : ''}`
  );

  await notifyRescue({
    event: 'rescue-runner',
    ts: Math.floor(Date.now() / 1000),
    message: `start ${source.name}`,
    source: source.name,
    bucket: source.bucket
  });

  await grinder.start(source, cursor);

  const stop = async (sig: string) => {
    console.log(`\n[runner] ${sig} — stopping grind…`);
    await grinder.stop();
    await notifyRescue({
      event: 'rescue-runner',
      ts: Math.floor(Date.now() / 1000),
      message: `stop ${sig}`,
      source: source.name,
      bucket: source.bucket
    });
    process.exit(EXIT_DONE);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  let lastRefresh = Date.now();
  // Status loop — grind runs in background on the engine; we just report.
  // Poll at least once per second so a near-instant done (exhausted space) is
  // noticed without waiting a full --status-sec interval.
  const pollMs = Math.min(1000, Math.max(200, statusSec * 1000));
  let lastStatusPrint = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const st = grinder.status;
    const now = Date.now();
    if (now - lastStatusPrint >= statusSec * 1000 || !st.running) {
      lastStatusPrint = now;
      const rate =
        st.spaceKind === 'rng-states'
          ? `${st.seedsPerSec ?? 0} states/s · ${st.seedsTried ?? 0} states · ${st.keysTried} keys`
          : `${st.keysPerSec} keys/s · ${st.keysTried} keys`;
      console.log(
        `[runner] ${st.running ? 'RUN' : 'IDLE'} ${st.sourceName ?? '—'} · ${rate} · hits=${st.hits} · backend=${st.backend} · workers=${st.workers}`
      );
    }

    if (!st.running) {
      const doneCursor = lastGrindCursor(source.name);
      const exhausted = spaceSize != null && doneCursor >= spaceSize;
      console.log(
        exhausted
          ? `[runner] grind complete — space exhausted (cursor=${doneCursor}/${spaceSize})`
          : '[runner] grind finished or stopped'
      );
      await notifyRescue({
        event: 'rescue-runner',
        ts: Math.floor(Date.now() / 1000),
        message: exhausted ? `complete ${source.name}` : `idle ${source.name}`,
        source: source.name,
        bucket: source.bucket
      });
      // Intentional completion — PM2 stop_exit_codes includes EXIT_DONE.
      process.exit(EXIT_DONE);
    }

    // Optional periodic richlist refresh (restarts grind so match-set reloads).
    if (refreshHours > 0 && Date.now() - lastRefresh > refreshHours * 3600_000) {
      console.log('[runner] scheduled richlist refresh — restarting grind with new match-set');
      await grinder.stop();
      try {
        await refreshRichlist();
      } catch (e) {
        console.error('[runner] refresh failed, resuming with old set:', e);
      }
      lastRefresh = Date.now();
      const cur = lastGrindCursor(source.name);
      if (spaceSize != null && cur >= spaceSize) {
        console.log(`[runner] after refresh: space still exhausted (cursor=${cur}/${spaceSize}) — exiting`);
        process.exit(EXIT_DONE);
      }
      await grinder.start(source, cur);
    }
  }
}

const cmd = process.argv[2];
if (cmd === 'check') {
  await cmdCheck(arg('--bucket', 'coldcard') ?? 'coldcard');
} else if (cmd === 'run') {
  await cmdRun();
} else {
  usage();
}
