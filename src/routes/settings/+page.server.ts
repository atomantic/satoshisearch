import type { PageServerLoad, Actions } from './$types';
import { fail } from '@sveltejs/kit';
import { config } from '$server/config';
import { openDb } from '$server/db';
import { tipHeight, recommendedFees } from '$server/mempool';
import { isVaultConfigured } from '$server/rescue/vault';
import { isLocalNode } from '$server/links';
import { indexPuzzles } from '$server/indexer/puzzles';
import { sweep } from '$server/sweep';

export const load: PageServerLoad = async () => {
  const db = openDb();
  const counts = db
    .prepare(
      `SELECT dataset, COUNT(*) c FROM target GROUP BY dataset`
    )
    .all() as Array<{ dataset: string; c: number }>;
  const runs = db
    .prepare(`SELECT kind, MAX(finished_at) last, SUM(processed) processed FROM scan_run GROUP BY kind`)
    .all() as Array<{ kind: string; last: number | null; processed: number }>;

  let node: { ok: boolean; tip: number | null; fastestFee: number | null } = { ok: false, tip: null, fastestFee: null };
  try {
    const [tip, fees] = await Promise.all([tipHeight(), recommendedFees().catch(() => null)]);
    node = { ok: true, tip, fastestFee: fees?.fastestFee ?? null };
  } catch {
    node = { ok: false, tip: null, fastestFee: null };
  }

  return {
    node,
    isLocal: isLocalNode(),
    config: {
      mempoolApiUrl: config.mempoolApiUrl,
      concurrency: config.concurrency,
      coinbaseMaxHeight: config.coinbaseMaxHeight,
      dataDir: config.dataDir,
      dryRun: config.rescue.dryRun,
      dest: config.rescue.destAddress,
      autoBuckets: [...config.rescue.autoBuckets],
      whitehatAttested: config.rescue.whitehatAttested,
      dustSats: config.rescue.dustSats,
      vaultReady: isVaultConfigured()
    },
    counts,
    runs
  };
};

export const actions: Actions = {
  indexPuzzles: async () => {
    const rows = await indexPuzzles();
    return { done: `Re-indexed ${rows.length} puzzles.` };
  },
  recheckPuzzles: async () => {
    const res = await sweep({ datasets: ['puzzle'], onlyFunded: true });
    return { done: `Re-checked ${res.scanned} puzzle targets · ${res.changed} changed.` };
  },
  recheckFunded: async () => {
    const res = await sweep({ onlyFunded: true });
    return { done: `Re-checked ${res.scanned} funded targets in ${(res.elapsedMs / 1000).toFixed(1)}s · ${res.moved.length} moved.` };
  }
};
