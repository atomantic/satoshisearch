/**
 * Compute devices — managed endpoints that can run kangaroo and/or sequential grind.
 *
 * Storage still lives under settings.kangaroo.runners for backward compatibility;
 * this module is the single place that resolves readiness and capabilities so
 * engines are not kangaroo-specific.
 *
 * Capabilities:
 *   kangaroo — ECDLP solvers (CPU satoshi-kangaroo, local/remote JLP CUDA, custom JSONL)
 *   grind    — sequential match (local satoshi-grind / JS, or remote satoshi-grind over SSH)
 *
 * Independent kangaroo herds do not share DPs. Grind devices receive work units
 * from the observatory (BATCH/RANGE protocol); remotes need satoshi-grind installed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  loadSettings,
  kangarooModeToBackend,
  kangarooBackendToMode,
  normalizeKangarooMode,
  normalizeRunnerConfig,
  defaultGrindEnabled,
  isLocalKind,
  DEFAULT_KANGAROO_SSH_WRAPPER,
  DEFAULT_KANGAROO_REMOTE_BIN,
  DEFAULT_REMOTE_GRIND_BIN,
  type KangarooMode,
  type KangarooBackend,
  type KangarooRunnerConfig,
  type AppSettings
} from '../settings';
import { resolveBinary, type NativeSpawnSpec } from './native';

export type DeviceCapability = 'kangaroo' | 'grind';

/** Runtime view with resolved paths, readiness, and job capabilities. */
export type ResolvedDevice = KangarooRunnerConfig & {
  backend: KangarooBackend;
  jlpUseGpuResolved: boolean;
  externalCmdResolved: string;
  remoteBinResolved: string;
  remoteGrindBinResolved: string;
  wrapperPathResolved: string;
  /** Kangaroo solver ready for this device. */
  kangarooAvailable: boolean;
  /** Sequential grind ready for this device. */
  grindAvailable: boolean;
  /** Union: either capability ready (legacy “available”). */
  available: boolean;
  capabilities: DeviceCapability[];
  detail: string;
  grindDetail: string;
};

export function newRunnerId(): string {
  return randomBytes(4).toString('hex');
}

export function emptyRunner(
  partial: Partial<KangarooRunnerConfig> & { kind: KangarooMode; name: string }
): KangarooRunnerConfig {
  const kind = partial.kind;
  return {
    id: partial.id || newRunnerId(),
    name: partial.name,
    enabled: partial.enabled ?? true,
    kind,
    jlpBin: partial.jlpBin ?? '',
    jlpExtraArgs: partial.jlpExtraArgs ?? '',
    jlpUseGpu: partial.jlpUseGpu ?? null,
    jlpGpuId: partial.jlpGpuId ?? '',
    externalCmd: partial.externalCmd ?? '',
    sshHost: partial.sshHost ?? '',
    sshOpts: partial.sshOpts ?? '',
    remoteBin: partial.remoteBin ?? '',
    wrapperPath: partial.wrapperPath ?? '',
    grindEnabled: partial.grindEnabled ?? defaultGrindEnabled(kind),
    remoteGrindBin: partial.remoteGrindBin ?? ''
  };
}

/** Same canonical shape as stored settings, but mints an id when one is missing. */
export function normalizeRunner(raw: unknown): KangarooRunnerConfig | null {
  return normalizeRunnerConfig(raw, newRunnerId);
}

/** Build a device list from legacy single-slot kangaroo fields (pre multi-runner). */
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
        enabled: true,
        grindEnabled: true
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
      wrapperPath: kg.wrapperPath,
      grindEnabled: defaultGrindEnabled(mode)
    })
  ];
}

function wrapperExists(path: string): boolean {
  return !!path && (existsSync(path) || existsSync(join(process.cwd(), path)));
}

function localCpuKangarooPath(): string | null {
  const candidates = [
    join(process.cwd(), 'native/grinder/satoshi-kangaroo'),
    join(process.cwd(), 'build/satoshi-kangaroo')
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function resolveDevice(r: KangarooRunnerConfig): ResolvedDevice {
  const backend = kangarooModeToBackend(r.kind);
  const wrapperPathResolved = r.wrapperPath || DEFAULT_KANGAROO_SSH_WRAPPER;
  const remoteBinResolved = r.remoteBin || DEFAULT_KANGAROO_REMOTE_BIN;
  const remoteGrindBinResolved = r.remoteGrindBin || DEFAULT_REMOTE_GRIND_BIN;
  let jlpUseGpuResolved = true;
  if (r.jlpUseGpu !== null) jlpUseGpuResolved = r.jlpUseGpu;

  let externalCmdResolved = r.externalCmd;
  if (r.kind === 'remote-gpu' && !r.externalCmd) {
    externalCmdResolved = `${wrapperPathResolved} {pubkey} {lo} {hi}`;
  }

  let kangarooAvailable = false;
  let grindAvailable = false;
  let detail = '';
  let grindDetail = '';

  if (r.kind === 'cpu') {
    const cpu = localCpuKangarooPath();
    kangarooAvailable = !!cpu;
    detail = cpu ? `cpu · kangaroo ${cpu}` : 'cpu · satoshi-kangaroo not built';
    // Local grind: native binary preferred; JS workers always work as fallback.
    const grindBin = resolveBinary();
    grindAvailable = !!r.grindEnabled;
    grindDetail = r.grindEnabled
      ? grindBin
        ? `grind · native ${grindBin}`
        : 'grind · JS workers (no satoshi-grind)'
      : 'grind · disabled';
  } else if (r.kind === 'local-gpu') {
    kangarooAvailable = !!(r.jlpBin && existsSync(r.jlpBin));
    detail = kangarooAvailable ? `local-gpu · ${r.jlpBin}` : 'local-gpu · set binary path';
    // Same host: sequential grind uses local satoshi-grind / JS.
    grindAvailable = !!r.grindEnabled;
    grindDetail = r.grindEnabled
      ? resolveBinary()
        ? `grind · local native`
        : 'grind · JS workers'
      : 'grind · disabled';
  } else if (r.kind === 'remote-gpu') {
    const hostOk = !!r.sshHost;
    const wrapOk = wrapperExists(wrapperPathResolved);
    kangarooAvailable = hostOk && wrapOk && !!externalCmdResolved;
    if (!hostOk) detail = 'remote · set SSH host';
    else if (!wrapOk) detail = `remote · kangaroo wrapper missing: ${wrapperPathResolved}`;
    else detail = `remote · kangaroo ${r.sshHost} · ${remoteBinResolved}`;

    grindAvailable = !!(r.grindEnabled && hostOk);
    if (!r.grindEnabled) grindDetail = 'grind · disabled';
    else if (!hostOk) grindDetail = 'grind · set SSH host';
    else grindDetail = `grind · ssh ${r.sshHost} · ${remoteGrindBinResolved}`;
  } else {
    // custom: kangaroo-only JSONL command
    kangarooAvailable = !!externalCmdResolved.trim();
    detail = kangarooAvailable ? `custom · ${externalCmdResolved}` : 'custom · command empty';
    grindAvailable = false;
    grindDetail = 'grind · not supported for custom JSONL';
  }

  const capabilities: DeviceCapability[] = [];
  if (kangarooAvailable) capabilities.push('kangaroo');
  if (grindAvailable) capabilities.push('grind');

  return {
    ...r,
    backend,
    jlpUseGpuResolved,
    externalCmdResolved,
    remoteBinResolved,
    remoteGrindBinResolved,
    wrapperPathResolved,
    kangarooAvailable,
    grindAvailable,
    available: kangarooAvailable || grindAvailable,
    capabilities,
    detail,
    grindDetail
  };
}

/**
 * All configured devices (migrated from legacy if needed), plus optional env
 * override that injects a remote host for CLI use.
 */
export function listDevices(): ResolvedDevice[] {
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
        wrapperPath: (process.env.KANGAROO_WRAPPER ?? '').trim(),
        grindEnabled: process.env.SATOSHI_GRIND_REMOTE === '1',
        remoteGrindBin: (process.env.SATOSHI_GRIND_REMOTE_BIN ?? '').trim()
      })
    ];
  }

  return runners.map(resolveDevice);
}

export function getDevice(id: string): ResolvedDevice | null {
  return listDevices().find((r) => r.id === id) ?? null;
}

/**
 * Pick devices by id for a capability.
 * empty/undefined ids → all enabled + capable (else any capable).
 */
export function pickDevices(
  capability: DeviceCapability,
  ids?: string[] | null
): ResolvedDevice[] {
  const all = listDevices();
  const capable = (r: ResolvedDevice) =>
    capability === 'kangaroo' ? r.kangarooAvailable : r.grindAvailable;

  if (!ids || ids.length === 0) {
    const enabled = all.filter((r) => r.enabled && capable(r));
    if (enabled.length) return enabled;
    return all.filter(capable);
  }
  const set = new Set(ids);
  return all.filter((r) => set.has(r.id) && capable(r));
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

export function runnerToDispatch(r: ResolvedDevice): RunnerDispatchConfig {
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

/**
 * How to spawn satoshi-grind for this device, or null if it cannot grind.
 *
 * Kind-specific knowledge (which hosts are local, how SSH argv is layered, which
 * config field holds the binary) stays here so the pool only maps devices → specs.
 * Custom opts go first: ssh takes the first value it sees for an option, so a
 * user-supplied `-i key` cannot silently drop BatchMode and hang on a passphrase.
 */
export function grindSpawnSpec(device: ResolvedDevice, threads: number): NativeSpawnSpec | null {
  if (!device.grindAvailable) return null;
  if (isLocalKind(device.kind)) return { mode: 'local', threads };
  if (device.kind !== 'remote-gpu' || !device.sshHost) return null;
  const opts = device.sshOpts ? device.sshOpts.split(/\s+/).filter(Boolean) : [];
  return {
    mode: 'ssh',
    sshArgv: [
      ...opts,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      device.sshHost
    ],
    remoteBinary: device.remoteGrindBinResolved,
    threads,
    deviceId: device.id,
    deviceName: device.name
  };
}
