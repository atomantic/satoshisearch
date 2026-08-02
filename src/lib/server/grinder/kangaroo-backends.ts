/**
 * Kangaroo backend dispatch.
 *
 *   cpu      — satoshi-kangaroo (libsecp256k1 + pthreads)
 *   jlp      — JeanLucPons/Kangaroo (or compatible) CUDA binary
 *   external — arbitrary command that emits our JSONL protocol on stdout
 *
 * Config: env (KANGAROO_*) or Settings → kangaroo section.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { effectiveGrind, effectiveKangaroo, type KangarooBackend } from '../settings';
import {
  listKangarooRunners,
  pickRunners,
  runnerToDispatch,
  type ResolvedKangarooRunner,
  type RunnerDispatchConfig
} from './kangaroo-runners';

export type KangarooProgress = {
  ops: number;
  dps: number;
  opsPerSec: number;
  elapsedMs: number;
};

export type KangarooRunResult =
  | { status: 'found'; privHex: string; ops: number; dps: number; elapsedMs: number }
  | { status: 'exhausted'; ops: number; elapsedMs: number }
  | { status: 'cancelled'; ops: number; elapsedMs: number }
  | { status: 'error'; message: string };

export interface KangarooSolveOpts {
  pubkeyHex: string;
  loHex: string;
  hiHex: string;
  threads?: number;
  dpBits?: number;
  maxOps?: number;
  onProgress?: (p: KangarooProgress) => void;
  /** Optional puzzle number for logging / templates. */
  puzzleN?: number;
  /** Dispatch config; defaults to effectiveKangaroo() single-slot. */
  config?: RunnerDispatchConfig;
  /** Optional runner id for progress tagging. */
  runnerId?: string;
  runnerName?: string;
}

function strip0x(h: string): string {
  return h.replace(/^0x/i, '').toLowerCase();
}

/** Pad hex scalar to even length (leading 0 nibble) then left-pad to 64 chars. */
export function padHexScalar(hex: string, width = 64): string {
  let h = strip0x(hex);
  if (h.length % 2) h = '0' + h;
  if (h.length > width) return h; // allow oversize; caller validates
  return h.padStart(width, '0');
}

export function normalizePrivHex(hex: string): string {
  return padHexScalar(hex, 64);
}

function resolveCpuBinary(): string | null {
  const env = process.env.SATOSHI_KANGAROO_BIN;
  if (env && existsSync(env)) return env;
  const candidates = [
    join(fileURLToPath(new URL('../../../../native/grinder/satoshi-kangaroo', import.meta.url))),
    join(process.cwd(), 'native/grinder/satoshi-kangaroo'),
    join(process.cwd(), 'build/satoshi-kangaroo'),
    join(process.cwd(), 'satoshi-kangaroo')
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function kangarooAvailability(): {
  backend: KangarooBackend;
  mode: string;
  available: boolean;
  detail: string;
  sshHost: string | null;
  runners: ResolvedKangarooRunner[];
  enabledCount: number;
  availableCount: number;
} {
  const runners = listKangarooRunners();
  const enabled = runners.filter((r) => r.enabled);
  const ready = enabled.filter((r) => r.available);
  const anyReady = runners.filter((r) => r.available);

  // Summary from primary ready runner (or first enabled / first overall).
  const primary = ready[0] ?? enabled[0] ?? runners[0] ?? null;
  if (!primary) {
    return {
      backend: 'cpu',
      mode: 'cpu',
      available: false,
      detail: 'no runners configured',
      sshHost: null,
      runners,
      enabledCount: 0,
      availableCount: 0
    };
  }

  const remotes = ready.filter((r) => r.kind === 'remote-gpu').map((r) => r.sshHost);
  const detail =
    ready.length > 1
      ? `${ready.length} runners ready · ${ready.map((r) => r.name).join(', ')}`
      : primary.detail;

  return {
    backend: primary.backend,
    mode: primary.kind,
    available: ready.length > 0 || anyReady.length > 0,
    detail,
    sshHost: remotes[0] ?? (primary.sshHost || null),
    runners,
    enabledCount: enabled.length,
    availableCount: ready.length
  };
}

export function kangarooAvailable(): boolean {
  return kangarooAvailability().available;
}

function defaultThreads(override?: number): number {
  if (override != null && override > 0) return override;
  try {
    return effectiveGrind().maxWorkers;
  } catch {
    return Math.max(1, availableParallelism() - 1);
  }
}

type Run = { promise: Promise<KangarooRunResult>; cancel: () => void };

/** A run that failed before the process ever started. */
function failedRun(message: string): Run {
  return { promise: Promise.resolve({ status: 'error', message }), cancel: () => {} };
}

/**
 * Feed a stream into `onLine`, one complete line at a time.
 *
 * Each stream gets its OWN buffer: stdout and stderr arrive as independent,
 * interleaved chunks, so a single shared buffer lets a partial stderr write
 * (JLP and our own progress lines end in bare \r) prefix the next stdout line
 * and corrupt it. Splits on \r as well so \r-updated progress lines are seen.
 */
function pumpLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let m: RegExpExecArray | null;
    const re = /\r\n|\r|\n/g;
    let start = 0;
    while ((m = re.exec(buf)) !== null) {
      onLine(buf.slice(start, m.index));
      start = m.index + m[0].length;
    }
    buf = buf.slice(start);
  });
}

/** SIGTERM, then SIGKILL if the child is still alive after `graceMs`. */
function killSoftThenHard(proc: ChildProcess, graceMs: number): void {
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, graceMs).unref?.();
  } catch {
    /* ignore */
  }
}

/* ---- JSONL stream parser (cpu + external) ------------------------------ */

function parseJsonlLine(
  line: string,
  onProgress: KangarooSolveOpts['onProgress'],
  finish: (r: KangarooRunResult) => void
): void {
  line = line.trim();
  if (!line.startsWith('{')) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const ev = String(msg.event ?? '');
  if (ev === 'progress') {
    onProgress?.({
      ops: Number(msg.ops ?? 0),
      dps: Number(msg.dps ?? 0),
      opsPerSec: Number(msg.opsPerSec ?? 0),
      elapsedMs: Number(msg.elapsedMs ?? 0)
    });
    return;
  }
  if (ev === 'found') {
    finish({
      status: 'found',
      privHex: normalizePrivHex(String(msg.priv ?? '')),
      ops: Number(msg.ops ?? 0),
      dps: Number(msg.dps ?? 0),
      elapsedMs: Number(msg.elapsedMs ?? 0)
    });
    return;
  }
  if (ev === 'exhausted') {
    finish({
      status: 'exhausted',
      ops: Number(msg.ops ?? 0),
      elapsedMs: Number(msg.elapsedMs ?? 0)
    });
    return;
  }
  if (ev === 'cancelled') {
    finish({
      status: 'cancelled',
      ops: Number(msg.ops ?? 0),
      elapsedMs: Number(msg.elapsedMs ?? 0)
    });
    return;
  }
  if (ev === 'error') {
    finish({ status: 'error', message: String(msg.message ?? 'unknown') });
  }
}

function attachJsonlProcess(proc: ChildProcess, opts: KangarooSolveOpts, label: string): Run {
  let settled = false;
  let lastOps = 0;
  let lastElapsed = 0;

  const promise = new Promise<KangarooRunResult>((resolve) => {
    const finish = (r: KangarooRunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const onLine = (line: string) =>
      parseJsonlLine(
        line,
        (p) => {
          lastOps = p.ops;
          lastElapsed = p.elapsedMs;
          opts.onProgress?.(p);
        },
        finish
      );

    pumpLines(proc.stdout, onLine);
    // Some wrappers only print JSONL on stderr.
    pumpLines(proc.stderr, onLine);

    proc.on('error', (err) => finish({ status: 'error', message: String(err) }));
    proc.on('exit', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGINT' || code === 130) {
        finish({ status: 'cancelled', ops: lastOps, elapsedMs: lastElapsed });
        return;
      }
      if (code !== 0) {
        finish({ status: 'error', message: `${label} exited code=${code} signal=${signal}` });
        return;
      }
      finish({ status: 'error', message: `${label} exited without result event` });
    });
  });

  return { promise, cancel: () => killSoftThenHard(proc, 2000) };
}

/* ---- CPU backend ------------------------------------------------------- */

function runCpu(opts: KangarooSolveOpts): Run {
  const bin = resolveCpuBinary();
  if (!bin) {
    return failedRun('satoshi-kangaroo not found — run: make -C native/grinder');
  }
  const threads = defaultThreads(opts.threads);
  const args = [
    '--pubkey',
    strip0x(opts.pubkeyHex),
    '--lo',
    strip0x(opts.loHex),
    '--hi',
    strip0x(opts.hiHex),
    '--threads',
    String(threads),
    // Tie the child's lifetime to our stdin pipe, the way satoshi-grind is tied
    // to its protocol pipe: if this process dies, the kangaroo does too rather
    // than running on at full core count with nothing able to stop it.
    '--stop-on-stdin-eof'
  ];
  if (opts.dpBits && opts.dpBits > 0) args.push('--dp', String(opts.dpBits));
  if (opts.maxOps && opts.maxOps > 0) args.push('--max-ops', String(opts.maxOps));

  const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  return attachJsonlProcess(proc, opts, 'satoshi-kangaroo');
}

/* ---- External JSONL backend -------------------------------------------- */

function expandTemplate(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k: string) => vars[k] ?? '');
}

/**
 * Split a command string into argv. Supports simple double-quoted tokens.
 * Not a full shell — use a wrapper script for complex pipelines.
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function runExternal(opts: KangarooSolveOpts): Run {
  const cfg = opts.config ?? effectiveKangaroo();
  const tmpl = cfg.externalCmd.trim();
  if (!tmpl) {
    return failedRun(
      'external backend: set KANGAROO_EXTERNAL_CMD or settings kangaroo.externalCmd'
    );
  }
  const threads = defaultThreads(opts.threads);
  const vars: Record<string, string> = {
    pubkey: strip0x(opts.pubkeyHex),
    lo: strip0x(opts.loHex),
    hi: strip0x(opts.hiHex),
    lo64: padHexScalar(opts.loHex),
    hi64: padHexScalar(opts.hiHex),
    threads: String(threads),
    dp: String(opts.dpBits ?? 0),
    max_ops: String(opts.maxOps ?? 0),
    puzzle: opts.puzzleN != null ? String(opts.puzzleN) : ''
  };
  const expanded = expandTemplate(tmpl, vars);
  const argv = splitCommand(expanded);
  if (!argv.length) {
    return failedRun('external command empty after expand');
  }
  const proc = spawn(argv[0], argv.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KANGAROO_PUBKEY: vars.pubkey,
      KANGAROO_LO: vars.lo,
      KANGAROO_HI: vars.hi,
      KANGAROO_LO64: vars.lo64,
      KANGAROO_HI64: vars.hi64,
      KANGAROO_THREADS: vars.threads,
      KANGAROO_DP: vars.dp,
      KANGAROO_MAX_OPS: vars.max_ops,
      KANGAROO_PUZZLE: vars.puzzle,
      // Remote-GPU wrapper reads these (settings / env). Do not clobber if empty.
      ...(cfg.sshHost ? { KANGAROO_SSH: cfg.sshHost } : {}),
      ...(cfg.sshOpts ? { KANGAROO_SSH_OPTS: cfg.sshOpts } : {}),
      ...(cfg.remoteBin ? { KANGAROO_JLP_REMOTE_BIN: cfg.remoteBin } : {}),
      ...(cfg.jlpExtraArgs ? { KANGAROO_JLP_EXTRA: cfg.jlpExtraArgs } : {}),
      ...(cfg.jlpGpuId ? { KANGAROO_JLP_GPU_ID: cfg.jlpGpuId } : {})
    }
  });
  return attachJsonlProcess(proc, opts, 'external-kangaroo');
}

/* ---- JeanLucPons / compatible CUDA ------------------------------------ */

/** Parse JLP-style progress line. Exported for tests. */
export function parseJlpProgress(line: string): KangarooProgress | null {
  // [7828.45 MK/s][GPU 7828.45 MK/s][Count 2^43.22][Dead 2][24:56 (Avg 20:24)][4.8/6.9GB]
  // [22.67 MKey/s][GPU 13.04 MKey/s][Count 2^29.06][Dead 0][28s][89.1MB]
  // The leading bracket is the total rate; a later [GPU …] is a subset of it.
  // Take the unit from whichever alternative matched rather than re-scanning the
  // whole line, which mis-scaled "[22.67 MKey/s][GPU 1.0 GKey/s]" by 1000x.
  const rate =
    /^\[([\d.]+)\s*([MG])(?:Key|K)\/s\]/i.exec(line) ??
    /\[([\d.]+)\s*([MG])(?:Key|K)\/s\]/i.exec(line);
  const count = line.match(/\[Count\s+2\^([\d.]+)\]/i);
  if (!rate && !count) return null;

  const opsPerSec = rate ? Number(rate[1]) * (rate[2].toUpperCase() === 'G' ? 1e9 : 1e6) : 0;

  let ops = 0;
  if (count) {
    const exp = Number(count[1]);
    if (Number.isFinite(exp)) ops = Math.round(Math.pow(2, exp));
  }

  // Time: [28s] or [24:56] or [01:02:03]
  let elapsedMs = 0;
  const t1 = line.match(/\[(\d+)s\]/);
  const t2 = line.match(/\[(\d+):(\d{2})(?:\s|\])/);
  const t3 = line.match(/\[(\d+):(\d{2}):(\d{2})/);
  if (t3) {
    elapsedMs = (Number(t3[1]) * 3600 + Number(t3[2]) * 60 + Number(t3[3])) * 1000;
  } else if (t2) {
    elapsedMs = (Number(t2[1]) * 60 + Number(t2[2])) * 1000;
  } else if (t1) {
    elapsedMs = Number(t1[1]) * 1000;
  }

  return { ops, dps: 0, opsPerSec, elapsedMs };
}

/** Parse Priv: 0x… from JLP output. Exported for tests. */
export function parseJlpPriv(line: string): string | null {
  const m = line.match(/Priv:\s*0x([0-9a-fA-F]+)/);
  return m ? normalizePrivHex(m[1]) : null;
}

function runJlp(opts: KangarooSolveOpts): Run {
  const cfg = opts.config ?? effectiveKangaroo();
  const bin = cfg.jlpBin;
  if (!bin || !existsSync(bin)) {
    return failedRun('JLP backend: set KANGAROO_JLP_BIN to your Kangaroo binary (CUDA build)');
  }

  const workDir = join(tmpdir(), `ss-kangaroo-${randomBytes(6).toString('hex')}`);
  mkdirSync(workDir, { recursive: true });
  const inFile = join(workDir, 'in.txt');
  const outFile = join(workDir, 'result.txt');

  // JLP input: start, end, pubkey (hex). Unpadded but byte-aligned, so strip
  // whole leading zero BYTES rather than nibbles.
  const trimScalar = (h: string) => padHexScalar(h).replace(/^(?:00)+/, '') || '00';
  writeFileSync(
    inFile,
    `${trimScalar(opts.loHex)}\n${trimScalar(opts.hiHex)}\n${strip0x(opts.pubkeyHex)}\n`,
    'utf8'
  );

  const args: string[] = [];
  // CPU threads: 0 = GPU-only (typical for CUDA boxes)
  const cpuThreads = opts.threads != null ? opts.threads : 0;
  args.push('-t', String(cpuThreads));
  if (cfg.jlpUseGpu) args.push('-gpu');
  if (cfg.jlpGpuId) args.push('-gpuId', cfg.jlpGpuId);
  if (opts.dpBits && opts.dpBits > 0) args.push('-d', String(opts.dpBits));
  if (opts.maxOps && opts.maxOps > 0) {
    // JLP -m is "maxStep * expected ops" multiplier-ish; pass as large step budget
    // Documented as: number of operations before give up (maxStep*expected)
    // Using maxOps as -m is a rough cap when user sets it.
    args.push('-m', String(opts.maxOps));
  }
  args.push('-o', outFile);
  if (cfg.jlpExtraArgs.trim()) {
    args.push(...splitCommand(cfg.jlpExtraArgs));
  }
  args.push(inFile);

  const t0 = Date.now();
  const proc = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: workDir,
    env: { ...process.env }
  });

  let settled = false;
  let lastOps = 0;
  let lastRate = 0;
  let lastElapsed = 0;
  let foundPriv: string | null = null;

  const cleanup = () => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  const promise = new Promise<KangarooRunResult>((resolve) => {
    const finish = (r: KangarooRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    const onLine = (line: string) => {
      const priv = parseJlpPriv(line);
      if (priv) foundPriv = priv;
      const prog = parseJlpProgress(line);
      if (prog) {
        lastOps = prog.ops || lastOps;
        lastRate = prog.opsPerSec || lastRate;
        lastElapsed = prog.elapsedMs || Date.now() - t0;
        opts.onProgress?.({ ops: lastOps, dps: 0, opsPerSec: lastRate, elapsedMs: lastElapsed });
      }
    };

    // pumpLines splits on \r too, which is how JLP redraws its progress line.
    pumpLines(proc.stdout, onLine);
    pumpLines(proc.stderr, onLine);

    proc.on('error', (err) => finish({ status: 'error', message: String(err) }));
    proc.on('exit', (code, signal) => {
      // Result file from -o
      try {
        if (existsSync(outFile)) {
          const body = readFileSync(outFile, 'utf8');
          for (const line of body.split(/\r?\n/)) {
            const p = parseJlpPriv(line);
            if (p) foundPriv = p;
            // Some builds write bare hex
            const bare = line.trim().match(/^(?:0x)?([0-9a-fA-F]{8,64})$/);
            if (bare && !foundPriv) foundPriv = normalizePrivHex(bare[1]);
          }
        }
      } catch {
        /* ignore */
      }

      const elapsed = Date.now() - t0;
      if (foundPriv) {
        finish({
          status: 'found',
          privHex: foundPriv,
          ops: lastOps,
          dps: 0,
          elapsedMs: elapsed
        });
        return;
      }
      if (signal === 'SIGTERM' || signal === 'SIGINT' || code === 130) {
        finish({ status: 'cancelled', ops: lastOps, elapsedMs: elapsed });
        return;
      }
      if (code !== 0) {
        finish({
          status: 'error',
          message: `JLP kangaroo exited code=${code} signal=${signal}`
        });
        return;
      }
      // Exit 0 without key — treat as exhausted
      finish({ status: 'exhausted', ops: lastOps, elapsedMs: elapsed });
    });
  });

  return { promise, cancel: () => killSoftThenHard(proc, 3000) };
}

/* ---- Public entry ------------------------------------------------------ */

export function runKangaroo(opts: KangarooSolveOpts): Run {
  const cfg = opts.config ?? effectiveKangaroo();
  if (cfg.backend === 'jlp') return runJlp({ ...opts, config: cfg });
  if (cfg.backend === 'external') return runExternal({ ...opts, config: cfg });
  return runCpu(opts);
}

/** Run on a resolved multi-runner definition. */
export function runKangarooOnRunner(runner: ResolvedKangarooRunner, opts: KangarooSolveOpts): Run {
  return runKangaroo({
    ...opts,
    runnerId: runner.id,
    runnerName: runner.name,
    config: runnerToDispatch(runner)
  });
}

export type MultiKangarooProgress = KangarooProgress & {
  runnerId: string;
  runnerName: string;
};

/**
 * Race several runners on the same range. First `found` wins; others are cancelled.
 * Progress is tagged per runner; aggregate ops/s is the sum of live rates.
 */
export function runKangarooMulti(
  runnerIds: string[] | null | undefined,
  opts: Omit<KangarooSolveOpts, 'config' | 'runnerId' | 'runnerName'> & {
    onRunnerProgress?: (p: MultiKangarooProgress) => void;
  }
): Run {
  const runners = pickRunners(runnerIds).filter((r) => r.available);
  if (!runners.length) {
    return failedRun('no available kangaroo runners — enable one in Settings');
  }
  if (runners.length === 1) {
    const r = runners[0];
    return runKangarooOnRunner(r, {
      ...opts,
      onProgress: (p) => {
        opts.onProgress?.(p);
        opts.onRunnerProgress?.({ ...p, runnerId: r.id, runnerName: r.name });
      }
    });
  }
  return runKangarooMultiImpl(runners, opts);
}

function runKangarooMultiImpl(
  runners: ResolvedKangarooRunner[],
  opts: Omit<KangarooSolveOpts, 'config' | 'runnerId' | 'runnerName'> & {
    onRunnerProgress?: (p: MultiKangarooProgress) => void;
  }
): Run {
  const cancels: Array<() => void> = [];
  let settled = false;
  const rates = new Map<string, number>();
  const opsMap = new Map<string, number>();
  let pending = runners.length;
  let lastNonFound: KangarooRunResult = { status: 'exhausted', ops: 0, elapsedMs: 0 };

  const promise = new Promise<KangarooRunResult>((resolve) => {
    const finish = (res: KangarooRunResult) => {
      if (settled) return;
      settled = true;
      for (const c of cancels) {
        try {
          c();
        } catch {
          /* ignore */
        }
      }
      resolve(res);
    };

    for (const r of runners) {
      const { promise: p, cancel } = runKangarooOnRunner(r, {
        ...opts,
        onProgress: (prog) => {
          rates.set(r.id, prog.opsPerSec);
          opsMap.set(r.id, prog.ops);
          let sumRate = 0;
          let sumOps = 0;
          for (const v of rates.values()) sumRate += v;
          for (const v of opsMap.values()) sumOps += v;
          opts.onProgress?.({
            ops: sumOps,
            dps: prog.dps,
            opsPerSec: sumRate,
            elapsedMs: prog.elapsedMs
          });
          opts.onRunnerProgress?.({ ...prog, runnerId: r.id, runnerName: r.name });
        }
      });
      cancels.push(cancel);
      p.then((res) => {
        if (settled) return;
        if (res.status === 'found') {
          finish(res);
          return;
        }
        lastNonFound = res;
        pending--;
        if (pending <= 0) finish(lastNonFound);
      }).catch((err) => {
        if (settled) return;
        lastNonFound = { status: 'error', message: String(err) };
        pending--;
        if (pending <= 0) finish(lastNonFound);
      });
    }
  });

  return {
    promise,
    cancel: () => {
      for (const c of cancels) {
        try {
          c();
        } catch {
          /* ignore */
        }
      }
    }
  };
}
