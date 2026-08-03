/**
 * Grinder engine — drives a candidate source through the worker pool, persists
 * progress, and on a match records the hit (encrypted), writes an audit entry,
 * files an owner-claim, and hands off to the rescue sweeper per policy.
 *
 * A module-level singleton so the UI can start/stop it and read live status.
 * One source runs at a time; switching sources stops the current run.
 */
import { openDb, nowSec } from '../db';
import type { Bucket } from '../config';
import { mayAutoSweep, effectiveGrind, effectiveMatchSet, type GrindPace, type MatchProfileId } from '../settings';
import { GrinderPool, coldcardWorkerCfg } from './pool';
import { loadMatchSet, findTargetByMatch } from './loadset';
import { recordHit } from './hit';
import { isVaultConfigured } from '../rescue/vault';
import { audit } from '../rescue/audit';
import type { GrindSource, SpaceKind } from './sources';
import type { Match } from './matchset';
import { generateColdcardSeeds, type RngSpaceModel } from './coldcard';
import { pickDevices, type ResolvedDevice } from './devices';

/**
 * What the last grind did, kept after it stops. Small spaces (lowentropy, the
 * ColdCard demo slices) can exhaust in seconds — without this the UI drops
 * straight back to Idle and Start looks like it did nothing.
 */
export interface GrindRunSummary {
  sourceName: string;
  /** exhausted = walked the whole space; stopped = user stop; error = threw. */
  reason: 'exhausted' | 'stopped' | 'error';
  keysTried: number;
  seedsTried: number | null;
  hits: number;
  /** Total work units in the space, when known. */
  spaceSize: string | null;
  /** Seconds the run lasted. */
  elapsed: number;
  finishedAt: number;
  error: string | null;
}

export interface GrinderStatus {
  running: boolean;
  sourceName: string | null;
  bucket: Bucket | null;
  workers: number;
  /** 'native' = satoshi-grind; 'js' = workers; 'multi' = local+remote devices. */
  backend: 'native' | 'js' | 'multi' | 'none';
  /**
   * Derived private keys checked (after BIP32 etc.). For coldcard this is
   * paths×gap per seed — not the RNG-state progress denominator.
   */
  keysTried: number;
  keysPerSec: number;
  /**
   * RNG seed states expanded (coldcard only). Null for sequential-key sources.
   * Progress through coldcard space is seedsTried / spaceSize, not keysTried.
   */
  seedsTried: number | null;
  seedsPerSec: number | null;
  spaceBits: number | null;
  spaceKind: SpaceKind | null;
  /** Total work units (seed states or keys) as decimal string when known. */
  spaceSize: string | null;
  /** Live resume cursor (seed index or key offset). */
  cursor: string | null;
  hits: number;
  startedAt: number | null;
  /** Coldcard dimension breakdown when running that source. */
  rngSpace: RngSpaceModel | null;
  /** Effective CPU pace (light/normal/full). */
  pace: GrindPace | null;
  throttleMs: number | null;
  /** Device ids participating in the current grind. */
  deviceIds: string[];
  /** Match-set profile active for this run (sequential grind only). */
  matchProfile: MatchProfileId | null;
  /** Human label for the active match filter. */
  matchLabel: string | null;
  /** Size of the match-set loaded for this run. */
  matchSetSize: number | null;
  /** Summary of the previous run, so a fast finish is visible. */
  lastRun: GrindRunSummary | null;
}

/** JS noble path is allocation-heavy; smaller batches keep latency low. */
export const BATCH_JS = 4000;
/** Native amortizes better with larger batches (single process + pthreads). */
export const BATCH_NATIVE = 16384;
/** Range mode is cheap to dispatch — larger slices fill the native threads. */
export const BATCH_RANGE = 65536;
/** Coldcard: seeds per job (each seed expands to many HD keys via PBKDF2). */
/** Coldcard: seeds per job (native OpenSSL PBKDF2 — larger batches OK). */
export const BATCH_COLDCARD_SEEDS = 32;

/**
 * Last persisted cursor for a source name, or 0n if there is none.
 *
 * The engine is the only writer of `grind_source` (see start/loop below), so
 * it also owns how a stored cursor is read back — including the "garbage or
 * missing means start over" rule. Both resume paths (the grinder start action
 * and `rescue-runner --resume`) go through here rather than re-deriving it.
 */
export function lastGrindCursor(sourceName: string): bigint {
  try {
    const row = openDb()
      .prepare(`SELECT cursor FROM grind_source WHERE name=?`)
      .get(sourceName) as { cursor: string } | undefined;
    if (row?.cursor) return BigInt(row.cursor);
  } catch {
    /* unreadable cursor — fall through to a fresh start */
  }
  return 0n;
}

class GrinderEngine {
  private pool: GrinderPool | null = null;
  private source: GrindSource | null = null;
  private running = false;
  private stopRequested = false;
  private keysTried = 0;
  private seedsTried = 0;
  private cursor: bigint | null = null;
  private startedAt: number | null = null;
  private lastRateSample = { t: 0, keys: 0, seeds: 0 };
  private keysPerSec = 0;
  private seedsPerSec = 0;
  private hits = 0;
  private rngSpace: RngSpaceModel | null = null;
  private pace: GrindPace | null = null;
  private throttleMs = 0;
  private deviceIds: string[] = [];
  /** Resolved match-set for the current run; the three parts always move together. */
  private match: ReturnType<typeof effectiveMatchSet> | null = null;
  private matchSetSize: number | null = null;
  private lastRun: GrindRunSummary | null = null;

  get status(): GrinderStatus {
    const kind = this.source?.spaceKind ?? null;
    return {
      running: this.running,
      sourceName: this.source?.name ?? null,
      bucket: this.source?.bucket ?? null,
      workers: this.pool?.workerCount ?? 0,
      backend: this.pool?.backendName ?? 'none',
      keysTried: this.keysTried,
      keysPerSec: Math.round(this.keysPerSec),
      seedsTried: kind === 'rng-states' ? this.seedsTried : null,
      seedsPerSec: kind === 'rng-states' ? Math.round(this.seedsPerSec) : null,
      spaceBits: this.source?.spaceBits ?? null,
      spaceKind: kind,
      spaceSize: this.source?.size != null ? this.source.size.toString() : null,
      cursor: this.cursor != null ? this.cursor.toString() : null,
      hits: this.hits,
      startedAt: this.startedAt,
      rngSpace: this.rngSpace,
      pace: this.running ? this.pace : null,
      throttleMs: this.running ? this.throttleMs : null,
      deviceIds: this.running ? [...this.deviceIds] : [],
      matchProfile: this.running ? (this.match?.profile ?? null) : null,
      matchLabel: this.running ? (this.match?.label ?? null) : null,
      matchSetSize: this.running ? this.matchSetSize : null,
      lastRun: this.lastRun
    };
  }

  /** Freeze what this run accomplished so the idle UI can report it. */
  private finish(source: GrindSource, reason: GrindRunSummary['reason'], error?: unknown): void {
    this.lastRun = {
      sourceName: source.name,
      reason,
      keysTried: this.keysTried,
      seedsTried: source.spaceKind === 'rng-states' ? this.seedsTried : null,
      hits: this.hits,
      spaceSize: source.size != null ? source.size.toString() : null,
      elapsed: this.startedAt != null ? Math.max(0, nowSec() - this.startedAt) : 0,
      finishedAt: nowSec(),
      error: error === undefined ? null : String(error)
    };
  }

  /**
   * @param source candidate source
   * @param resumeCursor optional resume offset
   * @param deviceIds optional grind-capable devices; omit = all enabled grind devices
   */
  async start(source: GrindSource, resumeCursor = 0n, deviceIds?: string[]): Promise<void> {
    if (this.running) await this.stop();
    this.source = source;
    this.running = true;
    this.stopRequested = false;
    this.keysTried = 0;
    this.seedsTried = 0;
    this.cursor = resumeCursor;
    this.hits = 0;
    this.lastRun = null;
    this.startedAt = nowSec();
    this.lastRateSample = { t: Date.now(), keys: 0, seeds: 0 };
    this.keysPerSec = 0;
    this.seedsPerSec = 0;

    this.rngSpace = source.rngSpace ?? null;
    const grind = effectiveGrind();
    this.pace = grind.pace;
    this.throttleMs = grind.throttleMs;

    const match = effectiveMatchSet();
    this.match = match;

    // Coldcard expand is local-only (PBKDF2); still accept device list but remotes
    // are ignored by the pool for coldcard jobs.
    const devices: ResolvedDevice[] = pickDevices('grind', deviceIds);

    const set = loadMatchSet(match.filter);
    this.matchSetSize = set.size;
    if (set.size === 0) {
      this.running = false;
      throw new Error(
        `match-set is empty for profile "${match.profile}" (${match.label}). ` +
          'Index targets or pick a broader match profile in Settings.'
      );
    }
    this.pool = new GrinderPool();
    await this.pool.start(set, devices.length ? devices : undefined);
    this.deviceIds = this.pool.activeDeviceIds;

    audit('grind-start', {
      source: source.name,
      bucket: source.bucket,
      matchSetSize: set.size,
      matchProfile: match.profile,
      matchLabel: match.label,
      matchDatasets: match.filter.datasets,
      matchPuzzleNs: match.filter.puzzleNs,
      workers: this.pool.workerCount,
      backend: this.pool.backendName,
      devices: this.deviceIds,
      pace: grind.pace,
      throttleMs: grind.throttleMs,
      maxWorkers: grind.maxWorkers,
      spaceKind: source.spaceKind ?? 'sequential-keys',
      spaceSize: source.size?.toString() ?? null,
      spaceBits: source.spaceBits,
      spaceUnit: source.spaceUnit ?? null,
      resumeCursor: resumeCursor.toString(),
      rngSpace: this.rngSpace
        ? {
            seedStates: this.rngSpace.seedStates.toString(),
            keysPerSeed: this.rngSpace.keysPerSeed,
            workBits: this.rngSpace.workBits,
            isDemoSlice: this.rngSpace.isDemoSlice
          }
        : null
    });

    // Persist source registration/progress.
    const db = openDb();
    db.prepare(
      `INSERT INTO grind_source (name, bucket, config_json, space_bits, cursor, keys_tried, enabled)
       VALUES (?, ?, ?, ?, ?, 0, 1)
       ON CONFLICT(name) DO UPDATE SET enabled=1, space_bits=excluded.space_bits`
    ).run(source.name, source.bucket, null, source.spaceBits, resumeCursor.toString());

    this.loop(source, resumeCursor).catch((err) => {
      audit('grind-error', { source: source.name, error: String(err) });
      this.finish(source, 'error', err);
      this.running = false;
    });
  }

  private async loop(source: GrindSource, startCursor: bigint): Promise<void> {
    const pool = this.pool!;
    let cursor = startCursor;
    this.cursor = cursor;
    const inflight: Promise<void>[] = [];
    const maxInflight = pool.workerCount * 2;

    const coldcardCfg = source.coldcardConfig;
    const useColdcardWorkers = source.bucket === 'coldcard' && !!coldcardCfg;
    const useRange = !useColdcardWorkers && !!source.rangeBatch;
    // Loop-invariant: serialized once, not rebuilt per job.
    const workerCfg = coldcardCfg ? coldcardWorkerCfg(coldcardCfg) : null;
    const grind = effectiveGrind();
    const scale = grind.batchScale;
    const throttle = grind.throttleMs;

    const batch = Math.max(
      1,
      Math.floor(
        (useColdcardWorkers
          ? BATCH_COLDCARD_SEEDS
          : useRange
            ? BATCH_RANGE
            : pool.backendName === 'native'
              ? BATCH_NATIVE
              : BATCH_JS) * scale
      )
    );

    // Light pace: keep pipeline shallow so we don't queue work faster than throttle.
    // Native processes one unit at a time; keep a small pipeline so the pipe stays full.
    // Coldcard JS workers can fan out across the whole pool.
    const pipeline =
      grind.pace === 'light'
        ? 1
        : useColdcardWorkers
          ? maxInflight
          : pool.backendName === 'native'
            ? Math.min(maxInflight, 3)
            : maxInflight;

    const yieldLoop = async () => {
      if (throttle > 0) await new Promise((r) => setTimeout(r, throttle));
      else await new Promise((r) => setImmediate(r));
    };

    while (!this.stopRequested) {
      if (useColdcardWorkers && coldcardCfg) {
        // Work unit = RNG seed state. Expand happens in workers:
        //   state → Yasmarang entropy → BIP39 → BIP32 → common paths → match
        const { seeds, nextCursor, done } = generateColdcardSeeds(coldcardCfg, cursor, batch);
        cursor = nextCursor;
        this.cursor = cursor;
        if (seeds.length) {
          const nSeeds = seeds.length;
          const job = pool
            .runColdcard(workerCfg!, seeds)
            .then((r) => this.onBatch(source, r.matches, r.checked, cursor, nSeeds));
          inflight.push(job);
          if (inflight.length >= pipeline) await inflight.shift();
        }
        await yieldLoop();
        if (done) break;
        continue;
      }

      if (useRange && source.rangeBatch) {
        const { range, nextCursor, done } = source.rangeBatch(cursor, batch);
        cursor = nextCursor;
        this.cursor = cursor;
        if (range && range.count > 0) {
          const job = pool
            .runRange(range)
            .then((r) => this.onBatch(source, r.matches, r.checked, cursor, 0));
          inflight.push(job);
          if (inflight.length >= pipeline) await inflight.shift();
        }
        await yieldLoop();
        if (done) break;
        continue;
      }

      const { items, nextCursor, done } = source.generate(cursor, batch);
      cursor = nextCursor;
      this.cursor = cursor;
      if (items.length) {
        const job = pool
          .run(items)
          .then((r) => this.onBatch(source, r.matches, r.checked, cursor, 0));
        inflight.push(job);
        if (inflight.length >= pipeline) await inflight.shift();
      }
      await yieldLoop();
      if (done) break;
    }
    await Promise.all(inflight);
    const reason = this.stopRequested ? 'stopped' : 'exhausted';
    this.finish(source, reason);
    this.running = false;
    audit('grind-stop', {
      source: source.name,
      reason,
      keysTried: this.keysTried,
      seedsTried: this.seedsTried || undefined,
      hits: this.hits
    });
    await pool.stop();
  }

  private async onBatch(
    source: GrindSource,
    matches: Match[],
    checked: number,
    cursor: bigint,
    seedsInBatch: number
  ): Promise<void> {
    this.keysTried += checked;
    if (seedsInBatch > 0) this.seedsTried += seedsInBatch;
    this.cursor = cursor;

    // Rolling rate sample.
    const now = Date.now();
    const dt = now - this.lastRateSample.t;
    if (dt >= 1000) {
      this.keysPerSec = ((this.keysTried - this.lastRateSample.keys) * 1000) / dt;
      this.seedsPerSec = ((this.seedsTried - this.lastRateSample.seeds) * 1000) / dt;
      this.lastRateSample = { t: now, keys: this.keysTried, seeds: this.seedsTried };
    }

    // Persist progress periodically (cheap; keys_tried + cursor for resume).
    // Cursor is seed index for coldcard, key offset for sequential sources.
    const db = openDb();
    db.prepare(`UPDATE grind_source SET keys_tried=?, cursor=? WHERE name=?`).run(
      this.keysTried,
      cursor.toString(),
      source.name
    );

    for (const m of matches) {
      this.hits++;
      await this.recordHit(source, m);
    }
  }

  private async recordHit(source: GrindSource, m: Match): Promise<void> {
    await recordHit(
      {
        sourceName: source.name,
        bucket: source.bucket as Bucket,
        origin: m.origin,
        matchKind: m.kind,
        matched: m.matched,
        privHex: m.privHex
      },
      findTargetByMatch(m.matched, m.kind, this.match?.filter ?? null)
    );
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  async stop(): Promise<void> {
    this.requestStop();
    // Give the loop a tick to observe the flag and drain.
    for (let i = 0; i < 50 && this.running; i++) await new Promise((r) => setTimeout(r, 40));
    if (this.pool) await this.pool.stop();
    this.running = false;
  }

  get vaultReady(): boolean {
    return isVaultConfigured();
  }
}

// One engine per server process.
export const grinder = new GrinderEngine();
