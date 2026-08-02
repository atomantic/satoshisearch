import type { PageServerLoad, Actions } from './$types';
import { fail } from '@sveltejs/kit';
import { grinder } from '$server/grinder/engine';
import { kangaroo } from '$server/grinder/kangaroo-engine';
import { makeSource, listSources } from '$server/grinder/registry';
import { matchSetCounts, latestRichlistSnapshot } from '$server/grinder/loadset';
import { effectiveRescue, effectiveGrind } from '$server/settings';

export const load: PageServerLoad = async () => {
  const snap = latestRichlistSnapshot();
  const rescue = effectiveRescue();
  const grind = effectiveGrind();
  return {
    status: grinder.status,
    vaultReady: grinder.vaultReady,
    sources: listSources(),
    matchSet: matchSetCounts(),
    kangaroo: kangaroo.status,
    kangarooTargets: kangaroo.listTargets().map((t) => ({
      n: t.n,
      address: t.address,
      halfBits: t.halfBits,
      balance: t.balance
    })),
    grind: {
      pace: grind.pace,
      maxWorkers: grind.maxWorkers,
      throttleMs: grind.throttleMs
    },
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

export const actions: Actions = {
  start: async ({ request }) => {
    const data = await request.formData();
    const id = String(data.get('source') ?? '');
    const source = makeSource(id);
    if (!source) return fail(400, { error: `unknown or unavailable source: ${id}` });
    await grinder.start(source);
    return { started: source.name };
  },
  stop: async () => {
    await grinder.stop();
    return { stopped: true };
  },
  kangarooStart: async ({ request }) => {
    const data = await request.formData();
    const n = Number(data.get('puzzle') ?? 0);
    if (!Number.isFinite(n) || n < 1) return fail(400, { error: 'invalid puzzle number' });
    try {
      await kangaroo.start(n);
      return { kangarooStarted: n };
    } catch (e) {
      return fail(400, { error: String(e) });
    }
  },
  kangarooStop: async () => {
    await kangaroo.stop();
    return { kangarooStopped: true };
  }
};
