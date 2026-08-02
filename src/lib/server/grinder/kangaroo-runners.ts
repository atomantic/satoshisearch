/**
 * Multi-runner kangaroo configuration.
 *
 * Operators can enable several solvers at once (local CPU, local CUDA, multiple
 * remote GPUs over SSH). A job races enabled runners: first `found` wins and
 * the others are cancelled.
 *
 * Independent herds do not share distinguished points — more runners add ops/s
 * but are less efficient than one multi-GPU JLP job. Still the right model for
 * "local + a few remotes" without a shared DP server.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  loadSettings,
  kangarooModeToBackend,
  kangarooBackendToMode,
  normalizeKangarooMode,
  normalizeKangarooBackend,
  DEFAULT_KANGAROO_SSH_WRAPPER,
  DEFAULT_KANGAROO_REMOTE_BIN,
  type KangarooMode,
  type KangarooBackend,
  type KangarooRunnerConfig,
  type AppSettings
} from '../settings';

/** @deprecated alias — use KangarooRunnerConfig */
export type KangarooRunner = KangarooRunnerConfig;

/** Runtime view with resolved paths and readiness. */
export type ResolvedKangarooRunner = KangarooRunnerConfig & {
  backend: KangarooBackend;
  jlpUseGpuResolved: boolean;
  externalCmdResolved: string;
  remoteBinResolved: string;
  wrapperPathResolved: string;
  available: boolean;
  detail: string;
};

export function newRunnerId(): string {
  return randomBytes(4).toString('hex');
}

export function emptyRunner(
  partial: Partial<KangarooRunnerConfig> & { kind: KangarooMode; name: string }
): KangarooRunnerConfig {
  return {
    id: partial.id || newRunnerId(),
    name: partial.name,
    enabled: partial.enabled ?? true,
    kind: partial.kind,
    jlpBin: partial.jlpBin ?? '',
    jlpExtraArgs: partial.jlpExtraArgs ?? '',
    jlpUseGpu: partial.jlpUseGpu ?? null,
    jlpGpuId: partial.jlpGpuId ?? '',
    externalCmd: partial.externalCmd ?? '',
    sshHost: partial.sshHost ?? '',
    sshOpts: partial.sshOpts ?? '',
    remoteBin: partial.remoteBin ?? '',
    wrapperPath: partial.wrapperPath ?? ''
  };
}

export function normalizeRunner(raw: unknown): KangarooRunnerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind =
    normalizeKangarooMode(r.kind) ||
    kangarooBackendToMode(normalizeKangarooBackend(r.backend), String(r.sshHost ?? ''));
  if (!kind) return null;
  const id = String(r.id ?? '').trim() || newRunnerId();
  const name = String(r.name ?? '').trim() || id;
  return {
    id,
    name,
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

/** Build a runner list from legacy single-slot kangaroo fields (pre multi-runner). */
export function migrateLegacyKangaroo(kg: AppSettings['kangaroo']): KangarooRunnerConfig[] {
  if (Array.isArray(kg.runners) && kg.runners.length) {
    return kg.runners.map((r) => normalizeRunner(r)).filter(Boolean) as KangarooRunnerConfig[];
  }

  const mode =
    normalizeKangarooMode(kg.mode) || kangarooBackendToMode(kg.backend || 'cpu', kg.sshHost);
  const hasLegacy = !!(
    kg.mode ||
    kg.backend ||
    kg.jlpBin ||
    kg.sshHost ||
    kg.externalCmd ||
    kg.remoteBin
  );
  if (!hasLegacy) {
    return [
      emptyRunner({
        id: 'cpu-local',
        name: 'CPU (this machine)',
        kind: 'cpu',
        enabled: true
      })
    ];
  }

  return [
    emptyRunner({
      id:
        mode === 'remote-gpu'
          ? 'remote-1'
          : mode === 'local-gpu'
            ? 'local-gpu'
            : mode === 'custom'
              ? 'custom-1'
              : 'cpu-local',
      name:
        mode === 'remote-gpu'
          ? kg.sshHost
            ? `GPU · ${kg.sshHost}`
            : 'Remote GPU'
          : mode === 'local-gpu'
            ? 'Local CUDA'
            : mode === 'custom'
              ? 'Custom command'
              : 'CPU (this machine)',
      enabled: true,
      kind: mode,
      jlpBin: kg.jlpBin,
      jlpExtraArgs: kg.jlpExtraArgs,
      jlpUseGpu: kg.jlpUseGpu,
      jlpGpuId: kg.jlpGpuId,
      externalCmd: kg.externalCmd,
      sshHost: kg.sshHost,
      sshOpts: kg.sshOpts,
      remoteBin: kg.remoteBin,
      wrapperPath: kg.wrapperPath
    })
  ];
}

function wrapperExists(path: string): boolean {
  return !!path && (existsSync(path) || existsSync(join(process.cwd(), path)));
}

export function resolveRunner(r: KangarooRunnerConfig): ResolvedKangarooRunner {
  const backend = kangarooModeToBackend(r.kind);
  const wrapperPathResolved = r.wrapperPath || DEFAULT_KANGAROO_SSH_WRAPPER;
  const remoteBinResolved = r.remoteBin || DEFAULT_KANGAROO_REMOTE_BIN;
  let jlpUseGpuResolved = true;
  if (r.jlpUseGpu !== null) jlpUseGpuResolved = r.jlpUseGpu;

  let externalCmdResolved = r.externalCmd;
  if (r.kind === 'remote-gpu' && !r.externalCmd) {
    externalCmdResolved = `${wrapperPathResolved} {pubkey} {lo} {hi}`;
  }

  let available = false;
  let detail = '';

  if (r.kind === 'cpu') {
    const candidates = [
      join(process.cwd(), 'native/grinder/satoshi-kangaroo'),
      join(process.cwd(), 'build/satoshi-kangaroo')
    ];
    const cpu = candidates.find((p) => existsSync(p));
    available = !!cpu;
    detail = cpu ? `cpu · ${cpu}` : 'cpu · satoshi-kangaroo not built';
  } else if (r.kind === 'local-gpu') {
    available = !!(r.jlpBin && existsSync(r.jlpBin));
    detail = available ? `local-gpu · ${r.jlpBin}` : 'local-gpu · set binary path';
  } else if (r.kind === 'remote-gpu') {
    const hostOk = !!r.sshHost;
    const wrapOk = wrapperExists(wrapperPathResolved);
    available = hostOk && wrapOk && !!externalCmdResolved;
    if (!hostOk) detail = 'remote-gpu · set SSH host';
    else if (!wrapOk) detail = `remote-gpu · wrapper missing: ${wrapperPathResolved}`;
    else detail = `remote-gpu · ${r.sshHost} · ${remoteBinResolved}`;
  } else {
    available = !!externalCmdResolved.trim();
    detail = available ? `custom · ${externalCmdResolved}` : 'custom · command empty';
  }

  return {
    ...r,
    backend,
    jlpUseGpuResolved,
    externalCmdResolved,
    remoteBinResolved,
    wrapperPathResolved,
    available,
    detail
  };
}

/**
 * All configured runners (migrated from legacy if needed), plus optional env
 * override that injects a remote host for CLI use.
 */
export function listKangarooRunners(): ResolvedKangarooRunner[] {
  const kg = loadSettings().kangaroo;
  let runners = migrateLegacyKangaroo(kg);

  const envSsh = (process.env.KANGAROO_SSH ?? '').trim();
  if (envSsh && !runners.some((r) => r.kind === 'remote-gpu' && r.sshHost === envSsh)) {
    runners = [
      ...runners,
      emptyRunner({
        id: 'env-remote',
        name: `GPU · ${envSsh} (env)`,
        kind: 'remote-gpu',
        enabled: true,
        sshHost: envSsh,
        sshOpts: (process.env.KANGAROO_SSH_OPTS ?? '').trim(),
        remoteBin: (process.env.KANGAROO_JLP_REMOTE_BIN ?? '').trim(),
        jlpGpuId: (process.env.KANGAROO_JLP_GPU_ID ?? '').trim(),
        jlpExtraArgs: (process.env.KANGAROO_JLP_EXTRA ?? '').trim(),
        wrapperPath: (process.env.KANGAROO_WRAPPER ?? '').trim()
      })
    ];
  }

  return runners.map(resolveRunner);
}

export function getRunner(id: string): ResolvedKangarooRunner | null {
  return listKangarooRunners().find((r) => r.id === id) ?? null;
}

/** Pick runners by id; empty/undefined → all enabled+available (else any available). */
export function pickRunners(ids?: string[] | null): ResolvedKangarooRunner[] {
  const all = listKangarooRunners();
  if (!ids || ids.length === 0) {
    const enabled = all.filter((r) => r.enabled && r.available);
    if (enabled.length) return enabled;
    return all.filter((r) => r.available);
  }
  const set = new Set(ids);
  return all.filter((r) => set.has(r.id));
}

/** Config slice consumed by kangaroo-backends run* functions. */
export type RunnerDispatchConfig = {
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
};

export function runnerToDispatch(r: ResolvedKangarooRunner): RunnerDispatchConfig {
  return {
    mode: r.kind,
    backend: r.backend,
    jlpBin: r.jlpBin,
    jlpExtraArgs: r.jlpExtraArgs,
    jlpUseGpu: r.jlpUseGpuResolved,
    jlpGpuId: r.jlpGpuId,
    externalCmd: r.externalCmdResolved,
    sshHost: r.sshHost,
    sshOpts: r.sshOpts,
    remoteBin: r.remoteBinResolved,
    wrapperPath: r.wrapperPathResolved
  };
}
