/**
 * Native grinder backend — spawns `satoshi-grind` (C + libsecp256k1) and speaks
 * the binary protocol. Falls back is handled by pool.ts when the binary is missing.
 *
 * Protocol (all multi-byte integers little-endian):
 *   → INIT  { n_h160:u32, h160s: n*20, n_pub:u32, [len:u8 + bytes]... }
 *   ← READY
 *   → BATCH { id:u32, count:u32, privs: count*32 }
 *   → RANGE { id:u32, count:u32, start:32 }   // sequential scalars in C
 *   ← RESULT { id:u32, checked:u32, n:u32, matches... }
 *   ← ERROR  { message bytes }
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToBytes, bytesToHex } from '../script';
import type { MatchSet, Match } from './matchset';
import type { KeyCandidate, RangeBatch } from './sources';
import { bigToPriv, originForRange } from './sources';

const MSG_INIT = 1;
const MSG_READY = 2;
const MSG_BATCH = 3;
const MSG_RESULT = 4;
const MSG_ERROR = 5;
const MSG_RANGE = 6;

const KIND_NAMES = ['hash160-compressed', 'hash160-uncompressed', 'pubkey'] as const;

function resolveBinary(): string | null {
  const env = process.env.SATOSHI_GRIND_BIN;
  if (env && existsSync(env)) return env;

  const candidates = [
    join(fileURLToPath(new URL('../../../../native/grinder/satoshi-grind', import.meta.url))),
    join(process.cwd(), 'native/grinder/satoshi-grind'),
    join(process.cwd(), 'build/satoshi-grind'),
    join(process.cwd(), 'satoshi-grind')
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function nativeGrindAvailable(): boolean {
  return resolveBinary() !== null;
}

function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function frame(type: number, payload: Buffer): Buffer {
  return Buffer.concat([u32(type), u32(payload.length), payload]);
}

function buildInitPayload(set: MatchSet): Buffer {
  const h160s = [...set.hash160s].map((h) => hexToBytes(h));
  const pubs = [...set.pubkeys].map((h) => hexToBytes(h));

  const parts: Buffer[] = [u32(h160s.length)];
  for (const h of h160s) {
    if (h.length !== 20) throw new Error(`hash160 must be 20 bytes, got ${h.length}`);
    parts.push(Buffer.from(h));
  }
  parts.push(u32(pubs.length));
  for (const p of pubs) {
    if (p.length !== 33 && p.length !== 65) {
      throw new Error(`pubkey must be 33 or 65 bytes, got ${p.length}`);
    }
    parts.push(Buffer.from([p.length]), Buffer.from(p));
  }
  return Buffer.concat(parts);
}

interface Pending {
  resolve: (v: { checked: number; matches: Match[] }) => void;
  reject: (e: unknown) => void;
  /** Explicit origins (BATCH) or a range for index-based origin (RANGE). */
  origins?: string[];
  range?: RangeBatch;
}

/**
 * One long-lived native process with an internal thread pool.
 */
export class NativeGrindPool {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private jobId = 0;
  private ready: Promise<void> | null = null;
  private threads: number;
  private binary: string;

  constructor(threads = Math.max(1, availableParallelism() - 1)) {
    this.threads = threads;
    const bin = resolveBinary();
    if (!bin) throw new Error('satoshi-grind binary not found — run: make -C native/grinder');
    this.binary = bin;
  }

  get workerCount(): number {
    return this.threads;
  }

  get backend(): 'native' {
    return 'native';
  }

  async start(set: MatchSet): Promise<void> {
    this.proc = spawn(this.binary, ['--threads', String(this.threads)], {
      stdio: ['pipe', 'pipe', 'inherit']
    });

    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onErr = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.proc?.off('error', onErr);
      };

      this.proc!.once('error', onErr);
      this._readyResolve = onReady;
      this._readyReject = onErr;
    });

    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.on('exit', (code, signal) => {
      const err = new Error(`satoshi-grind exited (code=${code} signal=${signal})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      if (this._readyReject) this._readyReject(err);
    });

    this.proc.stdin.write(frame(MSG_INIT, buildInitPayload(set)));
    await this.ready;
  }

  private _readyResolve: (() => void) | null = null;
  private _readyReject: ((e: Error) => void) | null = null;

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 8) return;
      const type = this.buf.readUInt32LE(0);
      const plen = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + plen) return;
      const payload = this.buf.subarray(8, 8 + plen);
      this.buf = this.buf.subarray(8 + plen);
      this.onMessage(type, payload);
    }
  }

  private onMessage(type: number, payload: Buffer): void {
    if (type === MSG_READY) {
      this._readyResolve?.();
      this._readyResolve = null;
      this._readyReject = null;
      return;
    }
    if (type === MSG_ERROR) {
      const msg = payload.toString('utf8');
      const err = new Error(`satoshi-grind: ${msg}`);
      if (this._readyReject) {
        this._readyReject(err);
        this._readyResolve = null;
        this._readyReject = null;
      }
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      return;
    }
    if (type !== MSG_RESULT) return;

    if (payload.length < 12) return;
    const id = payload.readUInt32LE(0);
    const checked = payload.readUInt32LE(4);
    const n = payload.readUInt32LE(8);
    let off = 12;
    const job = this.pending.get(id);
    if (!job) return;
    this.pending.delete(id);

    const matches: Match[] = [];
    for (let i = 0; i < n; i++) {
      const index = payload.readUInt32LE(off);
      off += 4;
      const kind = payload[off++];
      const mlen = payload[off++];
      const matched = payload.subarray(off, off + mlen);
      off += mlen;
      const priv = payload.subarray(off, off + 32);
      off += 32;
      const origin = job.range
        ? originForRange(job.range, index)
        : (job.origins?.[index] ?? `idx:${index}`);
      matches.push({
        privHex: bytesToHex(priv),
        origin,
        kind: KIND_NAMES[kind] ?? 'hash160-compressed',
        matched: bytesToHex(matched)
      });
    }
    job.resolve({ checked, matches });
  }

  run(candidates: KeyCandidate[]): Promise<{ checked: number; matches: Match[] }> {
    if (!this.proc) return Promise.reject(new Error('native pool not started'));
    const id = this.jobId++;
    const privs = Buffer.allocUnsafe(candidates.length * 32);
    const origins = new Array<string>(candidates.length);
    for (let i = 0; i < candidates.length; i++) {
      privs.set(candidates[i].priv, i * 32);
      origins[i] = candidates[i].origin;
    }
    const payload = Buffer.concat([u32(id), u32(candidates.length), privs]);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, origins });
      this.proc!.stdin.write(frame(MSG_BATCH, payload), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Sequential range — start + [0, count) generated and matched inside C. */
  runRange(range: RangeBatch): Promise<{ checked: number; matches: Match[] }> {
    if (!this.proc) return Promise.reject(new Error('native pool not started'));
    if (range.count <= 0) return Promise.resolve({ checked: 0, matches: [] });
    const id = this.jobId++;
    const startBuf = Buffer.from(bigToPriv(range.start));
    const payload = Buffer.concat([u32(id), u32(range.count), startBuf]);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, range });
      this.proc!.stdin.write(frame(MSG_RANGE, payload), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    p.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        p.kill('SIGKILL');
        resolve();
      }, 2000);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.pending.clear();
  }
}
