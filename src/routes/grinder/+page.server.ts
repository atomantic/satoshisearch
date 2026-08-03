import type { PageServerLoad, Actions } from './$types';
import { fail } from '@sveltejs/kit';
import { grinder, lastGrindCursor } from '$server/grinder/engine';
import { kangaroo } from '$server/grinder/kangaroo-engine';
import { makeSource, listSources } from '$server/grinder/registry';
import { matchSetCounts, latestRichlistSnapshot } from '$server/grinder/loadset';
import { listDevices } from '$server/grinder/devices';
import { effectiveRescue, effectiveGrind, effectiveMatchSet } from '$server/settings';
import { addressLink } from '$server/links';
import { btcShort } from '$lib/format';
import {
  PUBLIC_SCAN_NOTES,
  parseShardToken,
  isWindowSpecified,
  type WindowSpec
} from '$server/grinder/range-window';

/** Unified job id: `grind:<sourceId>` or `kangaroo:<n>`. */
export type JobId = string;

function buildJobs() {
  const grindJobs = listSources().map((s) => ({
    id: `grind:${s.id}`,
    method: 'grind' as const,
    sourceId: s.id,
    puzzleN: null as number | null,
    label: s.label,
    detail: s.description,
    bucket: s.bucket,
    spaceBits: s.spaceBits,
    spaceKind: s.spaceKind,
    spaceUnit: s.spaceUnit,
    available: s.available,
    note: s.note ?? null,
    halfBits: null as number | null,
    balance: null as number | null,
    address: null as string | null
  }));

  const kangJobs = kangaroo.listTargets().map((t) => ({
    id: `kangaroo:${t.n}`,
    method: 'kangaroo' as const,
    sourceId: null as string | null,
    puzzleN: t.n,
    label: `Puzzle #${t.n} · kangaroo`,
    detail: `Exposed ECDLP · expected ~2^${t.halfBits} group ops · ${btcShort(t.balance)} BTC`,
    bucket: 'puzzle',
    spaceBits: t.n, // full puzzle range for table display; work is ~2^halfBits
    spaceKind: 'ecdlp',
    spaceUnit: 'group ops',
    available: true,
    note: null as string | null,
    halfBits: t.halfBits,
    balance: t.balance,
    address: t.address
  }));

  // Kangaroo targets first (frontier), then grind sources.
  return [...kangJobs, ...grindJobs];
}

export const load: PageServerLoad = async () => {
  const snap = latestRichlistSnapshot();
  const rescue = effectiveRescue();
  const grind = effectiveGrind();
  const match = effectiveMatchSet();
  const kg = kangaroo.status;
  const st = grinder.status;
  const devices = listDevices();

  return {
    status: st,
    vaultReady: grinder.vaultReady,
    jobs: buildJobs(),
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      enabled: d.enabled,
      kangarooAvailable: d.kangarooAvailable,
      grindAvailable: d.grindAvailable,
      available: d.available,
      detail: d.detail,
      grindDetail: d.grindDetail,
      sshHost: d.sshHost,
      capabilities: d.capabilities
    })),
    matchSet: {
      ...matchSetCounts(match.filter),
      profile: match.profile,
      label: match.label,
      /** Early coinbase / dormant — Satoshi-era watch targets in the match set. */
      includesSatoshi:
        match.filter.datasets.includes('coinbase') || match.filter.datasets.includes('dormant'),
      includesRichlist: match.filter.datasets.includes('richlist')
    },
    kangaroo: { ...kg, addressLink: kg.address ? addressLink(kg.address) : null },
    grind: {
      pace: grind.pace,
      maxWorkers: grind.maxWorkers,
      throttleMs: grind.throttleMs
    },
    /** Public-scan guidance for range-start UI (not a coverage claim). */
    publicScanNotes: PUBLIC_SCAN_NOTES,
    richlistSnapshot: snap
      ? {
          source: snap.source,
          createdAt: snap.created_at,
          tipHeight: snap.tip_height,
          minSats: snap.min_sats,
          scriptPolicy: snap.script_policy,
          rowCount: snap.row_count,
          note: snap.note
        }
      : null,
    policy: {
      dryRun: rescue.dryRun,
      autoBuckets: [...rescue.autoBuckets],
      whitehatAttested: rescue.whitehatAttested,
      destConfigured: !!rescue.destAddress
    }
  };
};

function formIds(data: FormData, field: string): string[] {
  return data
    .getAll(field)
    .map((v) => String(v).trim())
    .filter(Boolean);
}

function numOrNull(raw: FormDataEntryValue | null): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Range window fields from the grinder start form (puzzle sequential jobs). */
function parseWindowFromForm(data: FormData): WindowSpec | null {
  const startHex = String(data.get('startHex') ?? '').trim() || null;
  const endHex = String(data.get('endHex') ?? '').trim() || null;
  const startPct = numOrNull(data.get('startPct'));
  const endPct = numOrNull(data.get('endPct'));
  const shard = parseShardToken(String(data.get('shard') ?? ''));

  const spec: WindowSpec = {
    startHex,
    endHex,
    startPct,
    endPct,
    shardIndex: shard?.shardIndex ?? null,
    shardCount: shard?.shardCount ?? null
  };
  return isWindowSpecified(spec) ? spec : null;
}

export const actions: Actions = {
  /** Unified start: job id selects grind vs kangaroo; devices apply to both. */
  start: async ({ request }) => {
    const data = await request.formData();
    const job = String(data.get('job') ?? '').trim();
    const deviceIds = formIds(data, 'devices');

    if (job.startsWith('kangaroo:')) {
      const n = Number(job.slice('kangaroo:'.length));
      if (!Number.isFinite(n) || n < 1) return fail(400, { error: 'invalid kangaroo job' });
      try {
        if (grinder.status.running) await grinder.stop();
        await kangaroo.start(n, deviceIds.length ? deviceIds : undefined);
        return { started: job, method: 'kangaroo', puzzle: n, devices: deviceIds };
      } catch (e) {
        return fail(400, { error: String(e) });
      }
    }

    // grind:… or bare source id for back-compat
    const sourceId = job.startsWith('grind:') ? job.slice('grind:'.length) : job;
    const window = parseWindowFromForm(data);
    let source;
    try {
      source = makeSource(sourceId, window);
    } catch (e) {
      return fail(400, { error: String(e) });
    }
    if (!source) return fail(400, { error: `unknown or unavailable source: ${sourceId}` });

    const resume = data.get('resume') === 'on' || data.get('resume') === '1';
    const cursor = resume ? lastGrindCursor(source.name) : 0n;

    try {
      if (kangaroo.status.running) await kangaroo.stop();
      await grinder.start(source, cursor, deviceIds.length ? deviceIds : undefined);
      return {
        started: source.name,
        method: 'grind',
        devices: deviceIds,
        cursor: cursor.toString(),
        window: window ?? null
      };
    } catch (e) {
      return fail(400, { error: String(e) });
    }
  },

  stop: async () => {
    const wasGrind = grinder.status.running;
    const wasKang = kangaroo.status.running;
    if (wasGrind) await grinder.stop();
    if (wasKang) await kangaroo.stop();
    return { stopped: true, grind: wasGrind, kangaroo: wasKang };
  },

  // Legacy action names still work (forms / bookmarks).
  kangarooStart: async ({ request }) => {
    const data = await request.formData();
    const n = Number(data.get('puzzle') ?? 0);
    if (!Number.isFinite(n) || n < 1) return fail(400, { error: 'invalid puzzle number' });
    const runnerIds = [...formIds(data, 'runners'), ...formIds(data, 'devices')];
    try {
      if (grinder.status.running) await grinder.stop();
      await kangaroo.start(n, runnerIds.length ? runnerIds : undefined);
      return { kangarooStarted: n, runners: runnerIds };
    } catch (e) {
      return fail(400, { error: String(e) });
    }
  },
  kangarooStop: async () => {
    await kangaroo.stop();
    return { kangarooStopped: true };
  }
};
