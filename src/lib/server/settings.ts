/**
 * Operator settings stored under DATA_DIR (default ./data/settings.json).
 *
 * These override env for Bitcoin RPC/Fulcrum, rescue policy, runtime tuning,
 * and richlist thresholds so the app can be fully configured from the
 * Settings UI without putting secrets or policy in .env / compose. The file
 * lives next to the SQLite DB and is gitignored.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { config, type Bucket } from './config';

export interface AppSettings {
  bitcoinRpc: {
    url: string;
    user: string;
    password: string;
    /** Optional cookie path; used only if user/password empty. */
    cookie: string;
  };
  fulcrum: {
    host: string;
    port: number;
  };
  rescue: {
    /** '' = unset, falls through to RESCUE_DEST_ADDRESS. */
    destAddress: string;
    /** null = unset, falls through to SWEEP_DRY_RUN. */
    dryRun: boolean | null;
    /** null = unset, falls through to SWEEP_DUST_SATS. */
    dustSats: number | null;
    /** null = unset, falls through to SWEEP_AUTO_BUCKETS. */
    autoBuckets: string[] | null;
    /** null = unset, falls through to RESCUE_WHITEHAT_ATTESTATION. */
    whitehatAttested: boolean | null;
  };
  runtime: {
    /** '' = unset, falls through to MEMPOOL_API_URL. */
    mempoolApiUrl: string;
    /** null = unset, falls through to MEMPOOL_CONCURRENCY. */
    concurrency: number | null;
    /** null = unset, falls through to COINBASE_MAX_HEIGHT. */
    coinbaseMaxHeight: number | null;
  };
  /**
   * Grinder pace — how hard the machine works overnight vs race mode.
   * Takes effect on the next grind start (not mid-run).
   */
  grind: {
    /** light | normal | full — default normal when unset-ish. */
    pace: GrindPace;
    /**
     * Hard cap on worker/thread count. 0 or null = derive from pace.
     * Light default is 2; normal/full use almost all cores.
     */
    maxWorkers: number | null;
    /**
     * Sleep this many ms after each batch/seed job. 0 or null = derive from pace
     * (light defaults to 150ms; normal/full 0).
     */
    throttleMs: number | null;
  };
  richlist: {
    /** null = unset, falls through to RICHLIST_MIN_SATS. */
    minSats: number | null;
    /** '' = unset, falls through to RICHLIST_SCRIPT_POLICY. */
    scriptPolicy: string;
    /** '' = unset, falls through to RICHLIST_LOYCE_URL. */
    loyceUrl: string;
  };
  /**
   * Pollard's kangaroo backend. Empty strings / nulls fall through to env
   * (KANGAROO_BACKEND, KANGAROO_JLP_BIN, KANGAROO_SSH, …).
   */
  kangaroo: {
    /**
     * Multi-runner list (preferred). When empty, legacy single-slot fields below
     * are migrated at read time by listKangarooRunners().
     */
    runners: KangarooRunnerConfig[];
    /**
     * @deprecated Single-slot fields — kept for migration / env parity.
     * Prefer `runners`.
     */
    mode: KangarooMode | '';
    backend: KangarooBackend | '';
    jlpBin: string;
    jlpExtraArgs: string;
    jlpUseGpu: boolean | null;
    jlpGpuId: string;
    externalCmd: string;
    sshHost: string;
    sshOpts: string;
    remoteBin: string;
    wrapperPath: string;
  };
  /**
   * '' = unset, falls through to VAULT_KEY_HEX. Only ever populated via
   * generateVaultKey() — there is no UI path to overwrite an existing key,
   * since rotating it orphans already-encrypted recovered private keys.
   */
  vaultKeyHex: string;
  /** Unix seconds of last successful save from the UI. */
  updatedAt: number | null;
}

/** How aggressively the grinder uses CPU. */
export type GrindPace = 'light' | 'normal' | 'full';

/** Kangaroo solver backend (dispatch layer). */
export type KangarooBackend = 'cpu' | 'jlp' | 'external';

/** Operator-facing kangaroo runner mode (Settings UI). */
export type KangarooMode = 'cpu' | 'local-gpu' | 'remote-gpu' | 'custom';

/** One kangaroo solver endpoint (local CPU/CUDA or remote SSH GPU). */
export type KangarooRunnerConfig = {
  id: string;
  name: string;
  enabled: boolean;
  kind: KangarooMode;
  jlpBin: string;
  jlpExtraArgs: string;
  jlpUseGpu: boolean | null;
  jlpGpuId: string;
  externalCmd: string;
  sshHost: string;
  sshOpts: string;
  remoteBin: string;
  wrapperPath: string;
};

/** Default local wrapper for remote-gpu mode. */
export const DEFAULT_KANGAROO_SSH_WRAPPER = 'scripts/kangaroo-ssh-wrapper.sh';
export const DEFAULT_KANGAROO_REMOTE_BIN = '/opt/Kangaroo/kangaroo';

/** Where an effective value came from, for the Settings page provenance badges. */
export type SettingsSource = 'settings' | 'env' | 'mixed' | 'none';

const DEFAULTS: AppSettings = {
  bitcoinRpc: { url: '', user: '', password: '', cookie: '' },
  fulcrum: { host: '', port: 50002 },
  rescue: { destAddress: '', dryRun: null, dustSats: null, autoBuckets: null, whitehatAttested: null },
  runtime: { mempoolApiUrl: '', concurrency: null, coinbaseMaxHeight: null },
  grind: { pace: 'normal', maxWorkers: null, throttleMs: null },
  richlist: { minSats: null, scriptPolicy: '', loyceUrl: '' },
  kangaroo: {
    runners: [],
    mode: '',
    backend: '',
    jlpBin: '',
    jlpExtraArgs: '',
    jlpUseGpu: null,
    jlpGpuId: '',
    externalCmd: '',
    sshHost: '',
    sshOpts: '',
    remoteBin: '',
    wrapperPath: ''
  },
  vaultKeyHex: '',
  updatedAt: null
};

function normalizePace(v: unknown): GrindPace {
  if (v === 'light' || v === 'normal' || v === 'full') return v;
  return 'normal';
}

export function normalizeKangarooBackend(v: unknown): KangarooBackend | '' {
  if (v === 'cpu' || v === 'jlp' || v === 'external') return v;
  return '';
}

export function normalizeKangarooMode(v: unknown): KangarooMode | '' {
  if (v === 'cpu' || v === 'local-gpu' || v === 'remote-gpu' || v === 'custom') return v;
  return '';
}

/** Map UI mode → dispatch backend. */
export function kangarooModeToBackend(mode: KangarooMode): KangarooBackend {
  if (mode === 'local-gpu') return 'jlp';
  if (mode === 'remote-gpu' || mode === 'custom') return 'external';
  return 'cpu';
}

/** Infer UI mode from a stored backend + optional SSH host. */
export function kangarooBackendToMode(
  backend: KangarooBackend | '',
  sshHost = ''
): KangarooMode {
  if (backend === 'jlp') return 'local-gpu';
  if (backend === 'external') return sshHost.trim() ? 'remote-gpu' : 'custom';
  return 'cpu';
}

function normalizeRunnerConfig(raw: unknown): KangarooRunnerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind =
    normalizeKangarooMode(r.kind) ||
    kangarooBackendToMode(normalizeKangarooBackend(r.backend), String(r.sshHost ?? ''));
  if (!kind) return null;
  const id = String(r.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    name: String(r.name ?? id).trim() || id,
    enabled: r.enabled === undefined ? true : Boolean(r.enabled),
    kind,
    jlpBin: String(r.jlpBin ?? '').trim(),
    jlpExtraArgs: String(r.jlpExtraArgs ?? '').trim(),
    jlpUseGpu: r.jlpUseGpu === null || r.jlpUseGpu === undefined ? null : Boolean(r.jlpUseGpu),
    jlpGpuId: String(r.jlpGpuId ?? '').trim(),
    externalCmd: String(r.externalCmd ?? '').trim(),
    sshHost: String(r.sshHost ?? '').trim(),
    sshOpts: String(r.sshOpts ?? '').trim(),
    remoteBin: String(r.remoteBin ?? '').trim(),
    wrapperPath: String(r.wrapperPath ?? '').trim()
  };
}

/** Prefer live env so CLI/tests can override DATA_DIR without reloading config. */
function dataDir(): string {
  return process.env.DATA_DIR || config.dataDir;
}

function settingsPath(): string {
  return join(dataDir(), 'settings.json');
}

/** Coerce to a finite number, or null if absent/blank/non-numeric ("unset"). */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerce to a boolean, or null if absent ("unset"). */
function boolOrNull(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return Boolean(v);
}

/** Provenance badge for a group of fields: settings win, env fills in the rest. */
function pickSource(fromSettings: boolean, fromEnv: boolean): SettingsSource {
  if (fromSettings && fromEnv) return 'mixed';
  if (fromSettings) return 'settings';
  return fromEnv ? 'env' : 'none';
}

function normalize(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const b: Partial<AppSettings['bitcoinRpc']> = raw?.bitcoinRpc ?? {};
  const f: Partial<AppSettings['fulcrum']> = raw?.fulcrum ?? {};
  const r: Partial<AppSettings['rescue']> = raw?.rescue ?? {};
  const rt: Partial<AppSettings['runtime']> = raw?.runtime ?? {};
  const g: Partial<AppSettings['grind']> = raw?.grind ?? {};
  const rl: Partial<AppSettings['richlist']> = raw?.richlist ?? {};
  const kg: Partial<AppSettings['kangaroo']> = raw?.kangaroo ?? {};
  const port = Number(f.port);
  return {
    bitcoinRpc: {
      url: String(b.url ?? '').trim().replace(/\/+$/, ''),
      user: String(b.user ?? '').trim(),
      password: String(b.password ?? ''),
      cookie: String(b.cookie ?? '').trim()
    },
    fulcrum: {
      host: String(f.host ?? '').trim(),
      port: Number.isFinite(port) && port > 0 ? port : 50002
    },
    rescue: {
      destAddress: String(r.destAddress ?? '').trim(),
      dryRun: boolOrNull(r.dryRun),
      dustSats: numOrNull(r.dustSats),
      autoBuckets: Array.isArray(r.autoBuckets)
        ? r.autoBuckets.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
        : null,
      whitehatAttested: boolOrNull(r.whitehatAttested)
    },
    runtime: {
      mempoolApiUrl: String(rt.mempoolApiUrl ?? '').trim().replace(/\/+$/, ''),
      concurrency: numOrNull(rt.concurrency),
      coinbaseMaxHeight: numOrNull(rt.coinbaseMaxHeight)
    },
    grind: {
      pace: normalizePace(g.pace),
      maxWorkers: numOrNull(g.maxWorkers),
      throttleMs: numOrNull(g.throttleMs)
    },
    richlist: {
      minSats: numOrNull(rl.minSats),
      scriptPolicy: String(rl.scriptPolicy ?? '').trim(),
      loyceUrl: String(rl.loyceUrl ?? '').trim()
    },
    kangaroo: {
      runners: Array.isArray(kg.runners)
        ? (kg.runners.map(normalizeRunnerConfig).filter(Boolean) as KangarooRunnerConfig[])
        : [],
      mode: normalizeKangarooMode(kg.mode),
      backend: normalizeKangarooBackend(kg.backend),
      jlpBin: String(kg.jlpBin ?? '').trim(),
      jlpExtraArgs: String(kg.jlpExtraArgs ?? '').trim(),
      jlpUseGpu: boolOrNull(kg.jlpUseGpu),
      jlpGpuId: String(kg.jlpGpuId ?? '').trim(),
      externalCmd: String(kg.externalCmd ?? '').trim(),
      sshHost: String(kg.sshHost ?? '').trim(),
      sshOpts: String(kg.sshOpts ?? '').trim(),
      remoteBin: String(kg.remoteBin ?? '').trim(),
      wrapperPath: String(kg.wrapperPath ?? '').trim()
    },
    vaultKeyHex: String(raw?.vaultKeyHex ?? '').trim(),
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : null
  };
}

/**
 * Parsed-settings cache. Every effectiveX() helper calls loadSettings(), and
 * those sit in per-request paths (mempool.req) and per-row paths (links.ts), so
 * an uncached readFileSync + JSON.parse here lands directly in the hot path.
 * Keyed on path + mtime + size so an external edit to settings.json is still
 * picked up, and so tests that swap DATA_DIR see their own file.
 */
let cache: { path: string; mtimeMs: number; size: number; value: AppSettings } | null = null;

/** Load settings from disk (or defaults if missing/corrupt). */
export function loadSettings(): AppSettings {
  const path = settingsPath();
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return structuredClone(DEFAULTS);
  }
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.value;
  }
  let value: AppSettings;
  try {
    value = normalize(JSON.parse(readFileSync(path, 'utf8')) as Partial<AppSettings>);
  } catch {
    return structuredClone(DEFAULTS);
  }
  cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

/** Persist settings to DATA_DIR/settings.json (creates data dir if needed). */
export function saveSettings(next: AppSettings): AppSettings {
  const normalized = normalize({ ...next, updatedAt: Math.floor(Date.now() / 1000) });
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const path = settingsPath();
  writeFileSync(path, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  // writeFileSync mode only applies on create — chmod so updates stay private too
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore on non-POSIX */
  }
  // Seed the cache directly rather than invalidating: two saves inside the same
  // millisecond can produce an identical mtime+size, which a stat check alone
  // would read as "unchanged".
  try {
    const stat = statSync(path);
    cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, value: normalized };
  } catch {
    cache = null;
  }
  return normalized;
}

/**
 * Merge a partial update. Empty password string means "leave unchanged"
 * when `keepPasswordIfEmpty` is true (UI form submits blank to avoid re-typing).
 */
export function updateSettings(
  patch: {
    bitcoinRpc?: Partial<AppSettings['bitcoinRpc']>;
    fulcrum?: Partial<AppSettings['fulcrum']>;
    rescue?: Partial<AppSettings['rescue']>;
    runtime?: Partial<AppSettings['runtime']>;
    grind?: Partial<AppSettings['grind']>;
    richlist?: Partial<AppSettings['richlist']>;
    kangaroo?: Partial<AppSettings['kangaroo']>;
  },
  opts: { keepPasswordIfEmpty?: boolean } = { keepPasswordIfEmpty: true }
): AppSettings {
  const cur = loadSettings();
  const br = { ...cur.bitcoinRpc, ...patch.bitcoinRpc };
  if (opts.keepPasswordIfEmpty && patch.bitcoinRpc && (patch.bitcoinRpc.password === undefined || patch.bitcoinRpc.password === '')) {
    br.password = cur.bitcoinRpc.password;
  }
  const fulcrum = { ...cur.fulcrum, ...patch.fulcrum };
  const rescue = { ...cur.rescue, ...patch.rescue };
  const runtime = { ...cur.runtime, ...patch.runtime };
  const grind = { ...cur.grind, ...patch.grind };
  const richlist = { ...cur.richlist, ...patch.richlist };
  const kangaroo = { ...cur.kangaroo, ...patch.kangaroo };
  return saveSettings({
    ...cur,
    bitcoinRpc: br,
    fulcrum,
    rescue,
    runtime,
    grind,
    richlist,
    kangaroo,
    updatedAt: null
  });
}

/** Clear Bitcoin RPC credentials (and optional Fulcrum) from disk. */
export function clearBitcoinRpcSettings(): AppSettings {
  const cur = loadSettings();
  return saveSettings({
    ...cur,
    bitcoinRpc: { url: '', user: '', password: '', cookie: '' },
    updatedAt: null
  });
}

/** Clear rescue policy overrides from disk (env fallbacks resume). */
export function clearRescueSettings(): AppSettings {
  const cur = loadSettings();
  return saveSettings({ ...cur, rescue: { ...DEFAULTS.rescue }, updatedAt: null });
}

/**
 * Effective Bitcoin RPC config: UI/file settings win when present, else env.
 * Does not throw if incomplete — callers use isRpcConfigured / resolveRpcAuth.
 */
export function effectiveBitcoinRpc(): {
  url: string;
  user: string;
  password: string;
  cookie: string;
  source: SettingsSource;
} {
  const s = loadSettings();
  const e = config.bitcoinRpc;
  return {
    url: s.bitcoinRpc.url || e.url,
    user: s.bitcoinRpc.user || e.user,
    password: s.bitcoinRpc.password || e.password,
    cookie: s.bitcoinRpc.cookie || e.cookie,
    source: pickSource(
      !!(s.bitcoinRpc.url || s.bitcoinRpc.user || s.bitcoinRpc.password || s.bitcoinRpc.cookie),
      !!(e.url || e.user || e.password || e.cookie)
    )
  };
}

/** Safe view for the Settings page (never returns raw password). */
export function bitcoinRpcPublicView(): {
  url: string;
  user: string;
  passwordSet: boolean;
  /** Cookie path from settings only — never the env one (see cookieFromEnv). */
  cookie: string;
  /** True when a cookie path is configured via env rather than the UI. */
  cookieFromEnv: boolean;
  source: SettingsSource;
  settingsPath: string;
  updatedAt: number | null;
} {
  const s = loadSettings();
  const eff = effectiveBitcoinRpc();
  return {
    url: eff.url,
    user: eff.user,
    passwordSet: !!eff.password || !!eff.cookie,
    cookie: s.bitcoinRpc.cookie,
    cookieFromEnv: !s.bitcoinRpc.cookie && !!config.bitcoinRpc.cookie,
    source: eff.source,
    settingsPath: settingsPath(),
    updatedAt: s.updatedAt
  };
}

/** Effective rescue policy: UI/file settings win per-field when present, else env. */
export function effectiveRescue(): {
  destAddress: string;
  dryRun: boolean;
  dustSats: number;
  autoBuckets: Set<string>;
  whitehatAttested: boolean;
  source: SettingsSource;
} {
  const s = loadSettings().rescue;
  const e = config.rescue;
  const destAddress = s.destAddress || e.destAddress;
  const dryRun = s.dryRun ?? e.dryRun;
  const dustSats = s.dustSats ?? e.dustSats;
  const autoBuckets = s.autoBuckets ?? [...e.autoBuckets];
  const whitehatAttested = s.whitehatAttested ?? e.whitehatAttested;

  // dryRun/dustSats/autoBuckets always carry a concrete default in config.ts
  // even with no env var set, so only destAddress/whitehatAttested (both
  // genuinely blank/false by default) can signal "env explicitly configured".
  const source = pickSource(
    !!(
      s.destAddress ||
      s.dryRun !== null ||
      s.dustSats !== null ||
      s.autoBuckets !== null ||
      s.whitehatAttested !== null
    ),
    !!(e.destAddress || e.whitehatAttested)
  );

  return { destAddress, dryRun, dustSats, autoBuckets: new Set(autoBuckets), whitehatAttested, source };
}

/** Effective runtime tuning: UI/file settings win per-field when present, else env. */
export function effectiveRuntime(): {
  mempoolApiUrl: string;
  concurrency: number;
  coinbaseMaxHeight: number;
  source: SettingsSource;
} {
  const s = loadSettings().runtime;
  const e = config;
  const mempoolApiUrl = s.mempoolApiUrl || e.mempoolApiUrl;
  const concurrency = s.concurrency ?? e.concurrency;
  const coinbaseMaxHeight = s.coinbaseMaxHeight ?? e.coinbaseMaxHeight;

  const fromSettings = !!(s.mempoolApiUrl || s.concurrency !== null || s.coinbaseMaxHeight !== null);
  const source: SettingsSource = fromSettings ? 'settings' : 'env';
  return { mempoolApiUrl, concurrency, coinbaseMaxHeight, source };
}

/**
 * Resolved grinder CPU pace for the next grind start.
 * Env overrides (optional): GRIND_PACE, GRIND_MAX_WORKERS, GRIND_THROTTLE_MS.
 */
export function effectiveGrind(): {
  pace: GrindPace;
  maxWorkers: number;
  throttleMs: number;
  /** Scale batch sizes (light ≈ 0.25). */
  batchScale: number;
  source: SettingsSource;
} {
  const cores = Math.max(1, availableParallelism());
  const s = loadSettings().grind;
  const envPace = normalizePace(process.env.GRIND_PACE);
  const pace =
    process.env.GRIND_PACE !== undefined && process.env.GRIND_PACE !== ''
      ? envPace
      : s.pace || 'normal';

  const envWorkers = numOrNull(process.env.GRIND_MAX_WORKERS);
  const envThrottle = numOrNull(process.env.GRIND_THROTTLE_MS);

  let maxWorkers: number;
  let throttleMs: number;
  let batchScale: number;

  if (pace === 'light') {
    maxWorkers = s.maxWorkers && s.maxWorkers > 0 ? s.maxWorkers : 2;
    throttleMs = s.throttleMs != null && s.throttleMs >= 0 ? s.throttleMs : 150;
    batchScale = 0.25;
  } else if (pace === 'full') {
    maxWorkers = s.maxWorkers && s.maxWorkers > 0 ? s.maxWorkers : cores;
    throttleMs = s.throttleMs != null && s.throttleMs >= 0 ? s.throttleMs : 0;
    batchScale = 1;
  } else {
    // normal: leave one core for UI/OS
    maxWorkers = s.maxWorkers && s.maxWorkers > 0 ? s.maxWorkers : Math.max(1, cores - 1);
    throttleMs = s.throttleMs != null && s.throttleMs >= 0 ? s.throttleMs : 0;
    batchScale = 1;
  }

  if (envWorkers != null && envWorkers > 0) maxWorkers = envWorkers;
  if (envThrottle != null && envThrottle >= 0) throttleMs = envThrottle;

  maxWorkers = Math.max(1, Math.min(maxWorkers, cores));

  const fromSettings = s.pace !== 'normal' || s.maxWorkers != null || s.throttleMs != null;
  const fromEnv = !!(process.env.GRIND_PACE || process.env.GRIND_MAX_WORKERS || process.env.GRIND_THROTTLE_MS);
  return {
    pace,
    maxWorkers,
    throttleMs,
    batchScale,
    source: pickSource(fromSettings, fromEnv)
  };
}

/**
 * Resolved kangaroo backend for the next kangaroo start.
 * Env: KANGAROO_BACKEND, KANGAROO_JLP_*, KANGAROO_EXTERNAL_CMD, KANGAROO_SSH,
 *      KANGAROO_JLP_REMOTE_BIN, KANGAROO_SSH_OPTS, KANGAROO_WRAPPER.
 */
export function effectiveKangaroo(): {
  mode: KangarooMode;
  backend: KangarooBackend;
  jlpBin: string;
  jlpExtraArgs: string;
  jlpUseGpu: boolean;
  jlpGpuId: string;
  externalCmd: string;
  sshHost: string;
  sshOpts: string;
  remoteBin: string;
  wrapperPath: string;
  source: SettingsSource;
} {
  const s = loadSettings().kangaroo;
  const env = (k: string) => (process.env[k] ?? '').trim();

  const sshHost = env('KANGAROO_SSH') || s.sshHost;
  const sshOpts = env('KANGAROO_SSH_OPTS') || s.sshOpts;
  const remoteBin = env('KANGAROO_JLP_REMOTE_BIN') || s.remoteBin || DEFAULT_KANGAROO_REMOTE_BIN;
  const wrapperPath =
    env('KANGAROO_WRAPPER') || s.wrapperPath || DEFAULT_KANGAROO_SSH_WRAPPER;

  const envBackend = normalizeKangarooBackend(process.env.KANGAROO_BACKEND);
  const envMode = normalizeKangarooMode(process.env.KANGAROO_MODE);
  const storedMode = normalizeKangarooMode(s.mode);

  // Mode precedence: env mode → env backend → stored mode → stored backend → cpu
  let mode: KangarooMode = 'cpu';
  if (envMode) {
    mode = envMode;
  } else if (envBackend) {
    mode = kangarooBackendToMode(envBackend, sshHost);
  } else if (storedMode) {
    mode = storedMode;
  } else if (s.backend) {
    mode = kangarooBackendToMode(s.backend, s.sshHost || sshHost);
  }

  const backend: KangarooBackend = kangarooModeToBackend(mode);

  const jlpBin = env('KANGAROO_JLP_BIN') || s.jlpBin;
  const jlpExtraArgs = env('KANGAROO_JLP_EXTRA') || s.jlpExtraArgs;
  const jlpGpuId = env('KANGAROO_JLP_GPU_ID') || s.jlpGpuId;

  // Tri-state: env wins, else the stored value, else default on.
  let jlpUseGpu = true;
  if (env('KANGAROO_JLP_GPU')) {
    jlpUseGpu = /^(1|true|yes|on)$/i.test(env('KANGAROO_JLP_GPU'));
  } else if (s.jlpUseGpu !== null) {
    jlpUseGpu = s.jlpUseGpu;
  }

  let externalCmd = env('KANGAROO_EXTERNAL_CMD') || s.externalCmd;
  // remote-gpu auto-builds the SSH wrapper command unless custom cmd is forced via env.
  if (mode === 'remote-gpu' && !env('KANGAROO_EXTERNAL_CMD')) {
    externalCmd = `${wrapperPath} {pubkey} {lo} {hi}`;
  }

  const ENV_KEYS = [
    'KANGAROO_MODE',
    'KANGAROO_BACKEND',
    'KANGAROO_JLP_BIN',
    'KANGAROO_JLP_EXTRA',
    'KANGAROO_JLP_GPU',
    'KANGAROO_JLP_GPU_ID',
    'KANGAROO_EXTERNAL_CMD',
    'KANGAROO_SSH',
    'KANGAROO_SSH_OPTS',
    'KANGAROO_JLP_REMOTE_BIN',
    'KANGAROO_WRAPPER'
  ];
  const fromSettings = !!(
    s.mode ||
    s.backend ||
    s.jlpBin ||
    s.jlpExtraArgs ||
    s.jlpGpuId ||
    s.jlpUseGpu !== null ||
    s.externalCmd ||
    s.sshHost ||
    s.sshOpts ||
    s.remoteBin ||
    s.wrapperPath
  );
  const fromEnv = ENV_KEYS.some((k) => process.env[k]);

  return {
    mode,
    backend,
    jlpBin,
    jlpExtraArgs,
    jlpUseGpu,
    jlpGpuId,
    externalCmd,
    sshHost,
    sshOpts,
    remoteBin,
    wrapperPath,
    source: pickSource(fromSettings, fromEnv)
  };
}

/** Effective richlist thresholds: UI/file settings win per-field when present, else env. */
export function effectiveRichlist(): {
  minSats: number;
  scriptPolicy: string;
  loyceUrl: string;
  source: SettingsSource;
} {
  const s = loadSettings().richlist;
  const e = config.richlist;
  const minSats = s.minSats ?? e.minSats;
  const scriptPolicy = s.scriptPolicy || e.scriptPolicy;
  const loyceUrl = s.loyceUrl || e.loyceUrl;

  const fromSettings = !!(s.minSats !== null || s.scriptPolicy || s.loyceUrl);
  const source: SettingsSource = fromSettings ? 'settings' : 'env';
  return { minSats, scriptPolicy, loyceUrl, source };
}

/** Effective vault key: UI/file settings win when present, else env. */
export function effectiveVaultKeyHex(): string {
  const s = loadSettings().vaultKeyHex;
  return s || config.rescue.vaultKeyHex;
}

/** Safe status view for the Settings page — never returns the key itself. */
export function vaultKeyStatusView(): {
  configured: boolean;
  source: 'settings' | 'env' | 'none';
  settingsPath: string;
} {
  const s = loadSettings().vaultKeyHex;
  const e = config.rescue.vaultKeyHex;
  const configured = /^[0-9a-fA-F]{64}$/.test(s || e);
  let source: 'settings' | 'env' | 'none' = 'none';
  if (s) source = 'settings';
  else if (e) source = 'env';
  return { configured, source, settingsPath: settingsPath() };
}

/**
 * Generate and persist a new 32-byte vault key, but only if none is currently
 * configured (settings or env). Rotating an existing key would make any
 * already-encrypted recovered private keys permanently undecryptable, so this
 * is a one-way "set once" operation — there is no UI path to overwrite it.
 * The generated key is never returned; it's written straight to disk.
 */
export function generateVaultKey(): { generated: boolean } {
  if (effectiveVaultKeyHex()) return { generated: false };
  const cur = loadSettings();
  saveSettings({ ...cur, vaultKeyHex: randomBytes(32).toString('hex'), updatedAt: null });
  return { generated: true };
}

/**
 * Whether a hit in this bucket may be swept without per-hit human approval.
 * Moved here (from config.ts) so it can read settings-overridden rescue
 * policy, not just the env-parsed defaults.
 */
export function mayAutoSweep(bucket: Bucket): boolean {
  const rescue = effectiveRescue();
  if (!rescue.autoBuckets.has(bucket)) return false;
  if (bucket === 'puzzle') return true;
  return rescue.whitehatAttested;
}
