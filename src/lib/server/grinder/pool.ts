/**
 * Worker pool that fans candidate batches across CPU cores. Each worker is
 * initialized once with the match-set, then fed ArrayBuffer batches of packed
 * 32-byte private keys. Keeps the SvelteKit server responsive during a grind.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MatchSet, Match } from './matchset';
import type { KeyCandidate } from './sources';

/**
 * Resolve worker.mjs in both worlds: next to this source file in dev, or in
 * build/ (copied by the Dockerfile) once SvelteKit has bundled the server. The
 * worker is plain ESM depending only on @noble, so plain node loads it in prod.
 */
function resolveWorkerPath(): string {
  const beside = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  if (existsSync(beside)) return beside;
  const built = join(process.cwd(), 'build', 'worker.mjs');
  if (existsSync(built)) return built;
  return beside; // let the Worker constructor surface a clear error
}
const WORKER_PATH = resolveWorkerPath();

interface PendingJob {
  resolve: (v: { checked: number; matches: Match[] }) => void;
  reject: (e: unknown) => void;
}

export class GrinderPool {
  private workers: Worker[] = [];
  private ready: Promise<void>[] = [];
  private jobId = 0;
  private pending = new Map<number, PendingJob>();
  private rr = 0;

  constructor(private size = Math.max(1, availableParallelism() - 1)) {}

  async start(set: MatchSet): Promise<void> {
    const hash160s = [...set.hash160s];
    const pubkeys = [...set.pubkeys];
    for (let i = 0; i < this.size; i++) {
      // tsx registers its loader for worker threads in dev; in the adapter-node
      // build this .mjs is copied as-is and loaded by plain node.
      const w = new Worker(WORKER_PATH, {
        execArgv: process.execArgv
      });
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

  /** Run one batch of candidates on the next worker (round-robin). */
  run(candidates: KeyCandidate[]): Promise<{ checked: number; matches: Match[] }> {
    const w = this.workers[this.rr++ % this.workers.length];
    const id = this.jobId++;
    const privs = new Uint8Array(candidates.length * 32);
    const origins = new Array<string>(candidates.length);
    for (let i = 0; i < candidates.length; i++) {
      privs.set(candidates[i].priv, i * 32);
      origins[i] = candidates[i].origin;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Transfer the buffer to avoid a copy.
      w.postMessage({ type: 'batch', id, privs: privs.buffer, origins }, [privs.buffer]);
    });
  }

  get workerCount(): number {
    return this.workers.length;
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.pending.clear();
  }
}
