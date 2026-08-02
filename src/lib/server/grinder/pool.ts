/**
 * Worker pool that fans candidate batches across CPU cores.
 *
 * Prefers the native `satoshi-grind` binary (libsecp256k1, ~10–50× faster).
 * Falls back to Node worker_threads + @noble when the binary is missing so
 * `npm test` / dev still work without a C toolchain.
 *
 * Also supports:
 *   runRange()     — sequential scalar ranges (native tweak_add or JS range)
 *   runColdcard()  — Yasmarang seed expand (always JS workers; PBKDF2-heavy)
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MatchSet, Match } from './matchset';
import type { KeyCandidate, RangeBatch } from './sources';
import { bigToPriv } from './sources';
import { NativeGrindPool, nativeGrindAvailable } from './native';
import type { ColdcardConfig } from './coldcard';
import type { YasmarangSeed } from './yasmarang';
import { effectiveGrind, isLocalKind } from '../settings';
import type { ResolvedDevice } from './devices';
import { grindSpawnSpec } from './devices';

function resolveWorkerPath(): string {
  const beside = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  if (existsSync(beside)) return beside;
  const built = join(process.cwd(), 'build', 'worker.mjs');
  if (existsSync(built)) return built;
  return beside;
}
const WORKER_PATH = resolveWorkerPath();

interface PendingJob {
  resolve: (v: { checked: number; matches: Match[] }) => void;
  reject: (e: unknown) => void;
}

/** Serialize ColdcardConfig expand fields for the worker (plain JSON). */
export type ColdcardWorkerCfg = {
  entropyBytes: 16 | 32;
  entropyStream: 'micropython' | 'libngu-xor';
  sha256dEntropy: boolean;
  pathTemplates: string[];
  addressGap: number;
};

export function coldcardWorkerCfg(cfg: ColdcardConfig): ColdcardWorkerCfg {
  return {
    entropyBytes: cfg.entropyBytes,
    entropyStream: cfg.entropyStream,
    sha256dEntropy: cfg.sha256dEntropy,
    pathTemplates: cfg.pathTemplates,
    addressGap: cfg.addressGap
  };
}

/** JS worker-thread backend. */
class JsGrindPool {
  private workers: Worker[] = [];
  private ready: Promise<void>[] = [];
  private jobId = 0;
  private pending = new Map<number, PendingJob>();
  private rr = 0;

  constructor(private size = Math.max(1, availableParallelism() - 1)) {}

  get workerCount(): number {
    return this.workers.length || this.size;
  }

  get backend(): 'js' {
    return 'js';
  }

  async start(set: MatchSet): Promise<void> {
    const hash160s = [...set.hash160s];
    const pubkeys = [...set.pubkeys];
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(WORKER_PATH);
      w.on('message', (msg: { type: string; id?: number; checked?: number; matches?: Match[] }) => {
        if (msg.type === 'result' && msg.id !== undefined) {
          const job = this.pending.get(msg.id);
          if (job) {
            this.pending.delete(msg.id);
            job.resolve({ checked: msg.checked ?? 0, matches: msg.matches ?? [] });
          }
        }
      });
      w.on('error', (err) => {
        for (const job of this.pending.values()) job.reject(err);
        this.pending.clear();
      });
      this.workers.push(w);
      this.ready.push(
        new Promise<void>((res) => {
          const onReady = (msg: { type: string }) => {
            if (msg.type === 'ready') {
              w.off('message', onReady);
              res();
            }
          };
          w.on('message', onReady);
        })
      );
      w.postMessage({ type: 'init', hash160s, pubkeys });
    }
    await Promise.all(this.ready);
  }

  private nextWorker(): Worker {
    return this.workers[this.rr++ % this.workers.length];
  }

  run(candidates: KeyCandidate[]): Promise<{ checked: number; matches: Match[] }> {
    const w = this.nextWorker();
    const id = this.jobId++;
    const privs = new Uint8Array(candidates.length * 32);
    const origins = new Array<string>(candidates.length);
    for (let i = 0; i < candidates.length; i++) {
      privs.set(candidates[i].priv, i * 32);
      origins[i] = candidates[i].origin;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ type: 'batch', id, privs: privs.buffer, origins }, [privs.buffer]);
    });
  }

  /** One range unit on a single worker (internal). */
  private runRangeChunk(range: RangeBatch): Promise<{ checked: number; matches: Match[] }> {
    const w = this.nextWorker();
    const id = this.jobId++;
    const start = new Uint8Array(bigToPriv(range.start));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage(
        {
          type: 'range',
          id,
          start: start.buffer,
          count: range.count,
          originPrefix: range.originPrefix,
          originDecimal: !!range.originDecimal
        },
        [start.buffer]
      );
    });
  }

  /** Fan sequential ranges across all workers so JS range mode scales. */
  async runRange(range: RangeBatch): Promise<{ checked: number; matches: Match[] }> {
    if (range.count <= 0) return { checked: 0, matches: [] };
    const n = Math.max(1, this.workers.length);
    const chunk = Math.ceil(range.count / n);
    const jobs: Promise<{ checked: number; matches: Match[] }>[] = [];
    for (let t = 0; t < n; t++) {
      const startOff = t * chunk;
      if (startOff >= range.count) break;
      const count = Math.min(chunk, range.count - startOff);
      jobs.push(
        this.runRangeChunk({
          start: range.start + BigInt(startOff),
          count,
          originPrefix: range.originPrefix,
          originDecimal: range.originDecimal
        })
      );
    }
    const parts = await Promise.all(jobs);
    let checked = 0;
    const matches: Match[] = [];
    for (const p of parts) {
      checked += p.checked;
      matches.push(...p.matches);
    }
    return { checked, matches };
  }

  runColdcard(
    cfg: ColdcardWorkerCfg,
    seeds: YasmarangSeed[]
  ): Promise<{ checked: number; matches: Match[] }> {
    if (!seeds.length) return Promise.resolve({ checked: 0, matches: [] });
    const w = this.nextWorker();
    const id = this.jobId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ type: 'coldcard-batch', id, cfg, seeds });
    });
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.pending.clear();
  }
}

type GrindBackend = {
  workerCount: number;
  backend: 'native' | 'js';
  start(set: MatchSet): Promise<void>;
  run(candidates: KeyCandidate[]): Promise<{ checked: number; matches: Match[] }>;
  runRange(range: RangeBatch): Promise<{ checked: number; matches: Match[] }>;
  stop(): Promise<void>;
};

/**
 * Fans BATCH/RANGE work across several native (local or SSH) backends.
 * Used when multiple grind-capable devices are selected.
 */
class MultiNativeGrindPool implements GrindBackend {
  private pools: NativeGrindPool[] = [];
  private rr = 0;
  readonly backend = 'native' as const;

  constructor(pools: NativeGrindPool[]) {
    this.pools = pools;
  }

  get workerCount(): number {
    return this.pools.reduce((s, p) => s + p.workerCount, 0);
  }

  async start(set: MatchSet): Promise<void> {
    await Promise.all(this.pools.map((p) => p.start(set)));
  }

  run(candidates: KeyCandidate[]): Promise<{ checked: number; matches: Match[] }> {
    if (!this.pools.length) return Promise.reject(new Error('no grind devices'));
    const p = this.pools[this.rr++ % this.pools.length];
    return p.run(candidates);
  }

  async runRange(range: RangeBatch): Promise<{ checked: number; matches: Match[] }> {
    if (range.count <= 0) return { checked: 0, matches: [] };
    if (!this.pools.length) return Promise.reject(new Error('no grind devices'));
    // Partition the range across devices so remotes work in parallel.
    const n = this.pools.length;
    const chunk = Math.ceil(range.count / n);
    const jobs: Promise<{ checked: number; matches: Match[] }>[] = [];
    for (let t = 0; t < n; t++) {
      const startOff = t * chunk;
      if (startOff >= range.count) break;
      const count = Math.min(chunk, range.count - startOff);
      jobs.push(
        this.pools[t].runRange({
          start: range.start + BigInt(startOff),
          count,
          originPrefix: range.originPrefix,
          originDecimal: range.originDecimal
        })
      );
    }
    const parts = await Promise.all(jobs);
    let checked = 0;
    const matches: Match[] = [];
    for (const p of parts) {
      checked += p.checked;
      matches.push(...p.matches);
    }
    return { checked, matches };
  }

  async stop(): Promise<void> {
    await Promise.all(this.pools.map((p) => p.stop()));
    this.pools = [];
  }
}

/**
 * Public pool: prefer native, else JS. Force JS with SATOSHI_GRIND_JS=1.
 * Coldcard expand always uses a JS worker pool (PBKDF2 is not in satoshi-grind).
 * Optional device list fans grind work across local + remote satoshi-grind.
 */
export class GrinderPool {
  private backend: GrindBackend | null = null;
  /** Side pool for coldcard when primary backend is native. */
  private coldcardPool: JsGrindPool | null = null;
  private matchSet: MatchSet | null = null;
  private workers = 0;
  private deviceIds: string[] = [];

  get workerCount(): number {
    // Prefer coldcard side pool size when that's what is actually expanding.
    if (this.coldcardPool) return this.coldcardPool.workerCount;
    return this.backend?.workerCount ?? this.workers;
  }

  get backendName(): 'native' | 'js' | 'multi' | 'none' {
    if (this.backend instanceof MultiNativeGrindPool) return 'multi';
    return this.backend?.backend ?? 'none';
  }

  get activeDeviceIds(): string[] {
    return [...this.deviceIds];
  }

  /**
   * @param devices optional grind-capable devices. Empty / omitted → local only.
   *   Remote devices need grindEnabled + satoshi-grind on the host.
   *   Coldcard always stays on local JS workers regardless of device list.
   */
  async start(set: MatchSet, devices?: ResolvedDevice[]): Promise<void> {
    this.matchSet = set;
    const grind = effectiveGrind();
    this.workers = grind.maxWorkers;
    this.deviceIds = [];
    const forceJs = process.env.SATOSHI_GRIND_JS === '1' || process.env.SATOSHI_GRIND_JS === 'true';

    const grindDevices = (devices ?? []).filter((d) => d.grindAvailable && d.enabled);
    const remotes = grindDevices.filter((d) => !isLocalKind(d.kind));
    // With no device list at all we still grind here; otherwise only if one was picked.
    const localIds = grindDevices.filter((d) => isLocalKind(d.kind)).map((d) => d.id);
    const wantLocal = grindDevices.length === 0 || localIds.length > 0;
    // Fallback id for the implicit local pool, which has no configured device.
    const localDeviceIds = localIds.length ? localIds : ['local'];

    // Multi-device path: at least one remote grind host.
    if (!forceJs && remotes.length > 0) {
      // Each device gets the full thread budget: remotes burn their own CPUs, and
      // only one local pool is ever created, so the observatory is not oversubscribed.
      const threads = Math.max(1, grind.maxWorkers);
      const pools: NativeGrindPool[] = [];
      if (wantLocal && nativeGrindAvailable()) {
        pools.push(new NativeGrindPool(threads));
        this.deviceIds.push(...localDeviceIds);
      }
      for (const d of remotes) {
        const spec = grindSpawnSpec(d, threads);
        if (!spec) continue;
        pools.push(new NativeGrindPool(spec));
        this.deviceIds.push(d.id);
      }
      if (pools.length === 1) {
        this.backend = pools[0];
        await this.backend.start(set);
        return;
      }
      if (pools.length > 1) {
        this.backend = new MultiNativeGrindPool(pools);
        await this.backend.start(set);
        return;
      }
      this.deviceIds = [];
      // No spawnable pool — fall through to local-only.
    }

    // Local only.
    this.deviceIds = localDeviceIds;
    this.backend =
      !forceJs && nativeGrindAvailable()
        ? new NativeGrindPool(grind.maxWorkers)
        : new JsGrindPool(grind.maxWorkers);
    await this.backend.start(set);
  }

  run(candidates: KeyCandidate[]): Promise<{ checked: number; matches: Match[] }> {
    if (!this.backend) return Promise.reject(new Error('pool not started'));
    return this.backend.run(candidates);
  }

  runRange(range: RangeBatch): Promise<{ checked: number; matches: Match[] }> {
    if (!this.backend) return Promise.reject(new Error('pool not started'));
    return this.backend.runRange(range);
  }

  async runColdcard(
    cfg: ColdcardWorkerCfg,
    seeds: YasmarangSeed[]
  ): Promise<{ checked: number; matches: Match[] }> {
    if (!this.backend) return Promise.reject(new Error('pool not started'));
    // Coldcard is always local JS (PBKDF2 + BIP39) — remotes do not expand seeds.
    if (this.backend instanceof JsGrindPool) {
      return this.backend.runColdcard(cfg, seeds);
    }
    if (!this.coldcardPool) {
      if (!this.matchSet) throw new Error('match set missing');
      this.coldcardPool = new JsGrindPool(this.workers || effectiveGrind().maxWorkers);
      await this.coldcardPool.start(this.matchSet);
    }
    return this.coldcardPool.runColdcard(cfg, seeds);
  }

  async stop(): Promise<void> {
    if (this.coldcardPool) {
      await this.coldcardPool.stop();
      this.coldcardPool = null;
    }
    if (this.backend) {
      await this.backend.stop();
      this.backend = null;
    }
    this.matchSet = null;
    this.deviceIds = [];
  }
}
