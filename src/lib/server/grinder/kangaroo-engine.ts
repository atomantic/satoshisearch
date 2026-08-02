/**
 * Kangaroo engine — races one or more runners (CPU / local CUDA / remote GPUs)
 * against exposed puzzle targets.
 */
import { puzzleHalfBits } from '../keyspace';
import { openDb, nowSec } from '../db';
import { audit } from '../rescue/audit';
import { findTargetByMatch } from './loadset';
import { recordHit } from './hit';
import {
  kangarooAvailability,
  runKangarooMulti,
  type KangarooProgress,
  type KangarooRunResult,
  type MultiKangarooProgress
} from './kangaroo-backends';
import { listKangarooRunners, type ResolvedKangarooRunner } from './kangaroo-runners';
import type { KangarooBackend } from '../settings';

export type ExposedPuzzle = {
  n: number;
  address: string;
  pubkey: string;
  rangeLo: string;
  rangeHi: string;
  balance: number;
  halfBits: number;
  targetId: number;
};

export type RunnerLiveStatus = {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  available: boolean;
  detail: string;
  sshHost: string;
  /** idle | running | found | error | cancelled | exhausted */
  status: string;
  ops: number;
  opsPerSec: number;
};

export type KangarooStatus = {
  available: boolean;
  backend: KangarooBackend;
  mode: string;
  backendDetail: string;
  sshHost: string | null;
  running: boolean;
  puzzleN: number | null;
  address: string | null;
  /** Target balance in sats, so the card can show what is at stake. */
  balance: number | null;
  halfBits: number | null;
  ops: number;
  opsPerSec: number;
  dps: number;
  elapsedMs: number;
  startedAt: number | null;
  lastResult: string | null;
  hits: number;
  /** Configured runners with live counters when a job is active. */
  runners: RunnerLiveStatus[];
  /** Runner ids selected for the current (or last) job. */
  activeRunnerIds: string[];
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
  private target: ExposedPuzzle | null = null;
  private ops = 0;
  private opsPerSec = 0;
  private dps = 0;
  private elapsedMs = 0;
  private startedAt: number | null = null;
  private lastResult: string | null = null;
  private hits = 0;
  private cancel: (() => void) | null = null;
  private done: Promise<void> | null = null;
  private activeRunnerIds: string[] = [];
  private live = new Map<string, { status: string; ops: number; opsPerSec: number }>();

  private runnerSnapshot(): RunnerLiveStatus[] {
    return listKangarooRunners().map((r) => {
      const live = this.live.get(r.id);
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        enabled: r.enabled,
        available: r.available,
        detail: r.detail,
        sshHost: r.sshHost,
        status: live?.status ?? (this.running && this.activeRunnerIds.includes(r.id) ? 'running' : 'idle'),
        ops: live?.ops ?? 0,
        opsPerSec: live?.opsPerSec ?? 0
      };
    });
  }

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
      balance: this.target?.balance ?? null,
      halfBits: this.target?.halfBits ?? null,
      ops: this.ops,
      opsPerSec: Math.round(this.opsPerSec),
      dps: this.dps,
      elapsedMs: this.elapsedMs,
      startedAt: this.startedAt,
      lastResult: this.lastResult,
      hits: this.hits,
      runners: this.runnerSnapshot(),
      activeRunnerIds: [...this.activeRunnerIds]
    };
  }

  listTargets(): ExposedPuzzle[] {
    return listExposedFromDb();
  }

  listRunners(): ResolvedKangarooRunner[] {
    return listKangarooRunners();
  }

  /**
   * @param puzzleN puzzle number
   * @param runnerIds optional subset; omit / empty = all enabled+available
   */
  async start(puzzleN: number, runnerIds?: string[]): Promise<void> {
    if (this.running) await this.stop();
    const avail = kangarooAvailability();
    if (!avail.available) {
      throw new Error(`kangaroo backend unavailable: ${avail.detail}`);
    }

    const target = listExposedFromDb().find((t) => t.n === puzzleN);
    if (!target) {
      throw new Error(`no exposed funded puzzle #${puzzleN} with stored pubkey`);
    }

    const ids = runnerIds?.length ? runnerIds : undefined;
    const selected = avail.runners.filter((r) => {
      if (ids) return ids.includes(r.id);
      return r.enabled && r.available;
    });
    const use = selected.filter((r) => r.available);
    if (!use.length) {
      throw new Error('no available runners selected — enable at least one in Settings');
    }

    this.running = true;
    this.target = target;
    this.ops = 0;
    this.opsPerSec = 0;
    this.dps = 0;
    this.elapsedMs = 0;
    this.startedAt = nowSec();
    this.lastResult = null;
    this.activeRunnerIds = use.map((r) => r.id);
    this.live.clear();
    for (const r of use) {
      this.live.set(r.id, { status: 'running', ops: 0, opsPerSec: 0 });
    }

    audit('kangaroo-start', {
      puzzleN: target.n,
      address: target.address,
      halfBits: target.halfBits,
      balanceSats: target.balance,
      rangeLo: target.rangeLo,
      rangeHi: target.rangeHi,
      runners: use.map((r) => ({ id: r.id, name: r.name, kind: r.kind, sshHost: r.sshHost || null }))
    });

    const { promise, cancel } = runKangarooMulti(use.map((r) => r.id), {
      pubkeyHex: target.pubkey,
      loHex: target.rangeLo,
      hiHex: target.rangeHi,
      puzzleN: target.n,
      onProgress: (p: KangarooProgress) => {
        this.ops = p.ops;
        this.opsPerSec = p.opsPerSec;
        this.dps = p.dps;
        this.elapsedMs = p.elapsedMs;
      },
      onRunnerProgress: (p: MultiKangarooProgress) => {
        this.live.set(p.runnerId, {
          status: 'running',
          ops: p.ops,
          opsPerSec: p.opsPerSec
        });
      }
    });
    this.cancel = cancel;

    this.done = promise
      .then((res) => this.onDone(target, res))
      .catch((err) => {
        this.lastResult = `error: ${err}`;
        audit('kangaroo-error', { puzzleN: target.n, error: String(err) });
        this.running = false;
        this.cancel = null;
        for (const id of this.activeRunnerIds) {
          const prev = this.live.get(id);
          this.live.set(id, { status: 'error', ops: prev?.ops ?? 0, opsPerSec: 0 });
        }
      });
  }

  private async onDone(target: ExposedPuzzle, res: KangarooRunResult): Promise<void> {
    this.cancel = null;
    this.running = false;

    if (res.status === 'error') {
      this.lastResult = `error: ${res.message}`;
      audit('kangaroo-error', { puzzleN: target.n, error: res.message });
      for (const id of this.activeRunnerIds) {
        const prev = this.live.get(id);
        this.live.set(id, { status: 'error', ops: prev?.ops ?? 0, opsPerSec: 0 });
      }
      return;
    }

    this.ops = res.ops;
    this.elapsedMs = res.elapsedMs;

    if (res.status === 'found') {
      this.hits++;
      this.dps = res.dps;
      this.lastResult = `found puzzle #${target.n}`;
      for (const id of this.activeRunnerIds) {
        const prev = this.live.get(id);
        this.live.set(id, { status: 'found', ops: prev?.ops ?? res.ops, opsPerSec: 0 });
      }
      await this.recordHit(target, res.privHex, res.ops);
      return;
    }

    const st = res.status === 'exhausted' ? 'exhausted' : 'cancelled';
    this.lastResult = res.status === 'exhausted' ? 'exhausted max-ops' : 'cancelled';
    for (const id of this.activeRunnerIds) {
      const prev = this.live.get(id);
      this.live.set(id, { status: st, ops: prev?.ops ?? res.ops, opsPerSec: 0 });
    }
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
    await this.done;
    this.running = false;
  }
}

export const kangaroo = new KangarooEngine();

/**
 * Runners are spawned into their own process group so that cancelling reaches
 * the remote-GPU wrapper's ssh and not just the wrapper. The trade-off is that
 * they no longer inherit the terminal's Ctrl-C, so shutting the server down has
 * to stop them explicitly — otherwise restarting the dev server strands a job
 * on the remote GPU with nothing left to cancel it.
 */
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void kangaroo
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  });
}
