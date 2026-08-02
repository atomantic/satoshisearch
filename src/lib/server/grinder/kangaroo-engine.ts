/**
 * Kangaroo engine — runs Pollard's kangaroo against exposed (pubkey-known)
 * puzzle targets via the native `satoshi-kangaroo` binary.
 *
 * Separate from the sequential grinder: different algorithm, different work unit
 * (EC group ops ≈ 2·√interval), same hit/rescue pipeline on success.
 */
import { openDb, nowSec } from '../db';
import { puzzleHalfBits } from '../keyspace';
import { audit } from '../rescue/audit';
import { findTargetByMatch } from './loadset';
import { recordHit } from './hit';
import {
  kangarooAvailability,
  runKangaroo,
  type KangarooProgress,
  type KangarooRunResult
} from './kangaroo-backends';
import type { KangarooBackend } from '../settings';

export type ExposedPuzzle = {
  n: number;
  address: string;
  pubkey: string;
  rangeLo: string;
  rangeHi: string;
  balance: number;
  /** Effective kangaroo work bits — see puzzleHalfBits(). */
  halfBits: number;
  targetId: number;
};

export type KangarooStatus = {
  available: boolean;
  backend: KangarooBackend;
  /** cpu | local-gpu | remote-gpu | custom */
  mode: string;
  backendDetail: string;
  sshHost: string | null;
  running: boolean;
  puzzleN: number | null;
  address: string | null;
  halfBits: number | null;
  ops: number;
  opsPerSec: number;
  dps: number;
  elapsedMs: number;
  startedAt: number | null;
  lastResult: string | null;
  hits: number;
};

function listExposedFromDb(): ExposedPuzzle[] {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT p.n, p.range_lo, p.range_hi, p.balance, t.address, t.pubkey, t.id AS target_id
       FROM puzzle p
       JOIN target t ON t.id = p.target_id
       WHERE p.status = 'exposed' AND p.balance > 0
         AND t.pubkey IS NOT NULL AND length(t.pubkey) >= 66
       ORDER BY p.n`
    )
    .all() as Array<{
    n: number;
    range_lo: string;
    range_hi: string;
    balance: number;
    address: string;
    pubkey: string;
    target_id: number;
  }>;

  return rows.map((r) => ({
    n: r.n,
    address: r.address,
    pubkey: r.pubkey,
    rangeLo: r.range_lo,
    rangeHi: r.range_hi,
    balance: r.balance,
    halfBits: puzzleHalfBits(r.n),
    targetId: r.target_id
  }));
}

class KangarooEngine {
  private running = false;
  /** The puzzle this run is (or last was) against; puzzleN/address/halfBits derive from it. */
  private target: ExposedPuzzle | null = null;
  private ops = 0;
  private opsPerSec = 0;
  private dps = 0;
  private elapsedMs = 0;
  private startedAt: number | null = null;
  private lastResult: string | null = null;
  private hits = 0;
  private cancel: (() => void) | null = null;
  /** Resolves when the current run settles; lets stop() wait for the real exit. */
  private done: Promise<void> | null = null;

  get status(): KangarooStatus {
    const avail = kangarooAvailability();
    return {
      available: avail.available,
      backend: avail.backend,
      mode: avail.mode,
      backendDetail: avail.detail,
      sshHost: avail.sshHost,
      running: this.running,
      puzzleN: this.target?.n ?? null,
      address: this.target?.address ?? null,
      halfBits: this.target?.halfBits ?? null,
      ops: this.ops,
      opsPerSec: Math.round(this.opsPerSec),
      dps: this.dps,
      elapsedMs: this.elapsedMs,
      startedAt: this.startedAt,
      lastResult: this.lastResult,
      hits: this.hits
    };
  }

  listTargets(): ExposedPuzzle[] {
    return listExposedFromDb();
  }

  async start(puzzleN: number): Promise<void> {
    if (this.running) await this.stop();
    const avail = kangarooAvailability();
    if (!avail.available) {
      throw new Error(`kangaroo backend unavailable: ${avail.detail}`);
    }

    const target = listExposedFromDb().find((t) => t.n === puzzleN);
    if (!target) {
      throw new Error(`no exposed funded puzzle #${puzzleN} with stored pubkey`);
    }

    this.running = true;
    this.target = target;
    this.ops = 0;
    this.opsPerSec = 0;
    this.dps = 0;
    this.elapsedMs = 0;
    this.startedAt = nowSec();
    this.lastResult = null;

    audit('kangaroo-start', {
      puzzleN: target.n,
      address: target.address,
      halfBits: target.halfBits,
      balanceSats: target.balance,
      rangeLo: target.rangeLo,
      rangeHi: target.rangeHi,
      backend: avail.backend,
      backendDetail: avail.detail
    });

    const { promise, cancel } = runKangaroo({
      pubkeyHex: target.pubkey,
      loHex: target.rangeLo,
      hiHex: target.rangeHi,
      puzzleN: target.n,
      onProgress: (p: KangarooProgress) => {
        this.ops = p.ops;
        this.opsPerSec = p.opsPerSec;
        this.dps = p.dps;
        this.elapsedMs = p.elapsedMs;
      }
    });
    this.cancel = cancel;

    // Detach — status is polled from the UI; errors are audited. stop() awaits
    // `done` so it reports finished only once the child has actually exited.
    this.done = promise
      .then((res) => this.onDone(target, res))
      .catch((err) => {
        this.lastResult = `error: ${err}`;
        audit('kangaroo-error', { puzzleN: target.n, error: String(err) });
        this.running = false;
        this.cancel = null;
      });
  }

  private async onDone(target: ExposedPuzzle, res: KangarooRunResult): Promise<void> {
    this.cancel = null;
    this.running = false;

    if (res.status === 'error') {
      this.lastResult = `error: ${res.message}`;
      audit('kangaroo-error', { puzzleN: target.n, error: res.message });
      return;
    }

    // Every non-error result carries the run's final counters.
    this.ops = res.ops;
    this.elapsedMs = res.elapsedMs;

    if (res.status === 'found') {
      this.hits++;
      this.dps = res.dps;
      this.lastResult = `found puzzle #${target.n}`;
      await this.recordHit(target, res.privHex, res.ops);
      return;
    }

    this.lastResult = res.status === 'exhausted' ? 'exhausted max-ops' : 'cancelled';
    audit('kangaroo-stop', { puzzleN: target.n, reason: res.status, ops: res.ops });
  }

  private async recordHit(target: ExposedPuzzle, privHex: string, ops: number): Promise<void> {
    await recordHit(
      {
        sourceName: `kangaroo-puzzle-${target.n}`,
        bucket: 'puzzle',
        origin: `kangaroo:#${target.n}:ops=${ops}`,
        matchKind: 'pubkey',
        matched: target.pubkey,
        privHex,
        extra: { kangarooOps: ops, halfBits: target.halfBits },
        fallbackBalance: target.balance
      },
      findTargetByMatch(target.pubkey, 'pubkey')
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.cancel?.();
    this.cancel = null;
    // Wait for the child to actually exit rather than guessing at a delay —
    // otherwise a restart can leave two full-core processes running at once.
    await this.done;
    this.running = false;
  }
}

export const kangaroo = new KangarooEngine();
