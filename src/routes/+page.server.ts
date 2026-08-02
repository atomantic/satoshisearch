import type { PageServerLoad } from './$types';
import { openDb } from '$server/db';
import { effectiveRescue, effectiveRuntime } from '$server/settings';
import { tipHeight } from '$server/mempool';

export const load: PageServerLoad = async () => {
  const db = openDb();

  const q = (sql: string) =>
    db.prepare(sql).get() as unknown as Record<string, number> | undefined;

  const dormant = q(
    `SELECT COUNT(*) c, COALESCE(SUM(last_balance),0) s FROM target WHERE dataset IN ('coinbase','dormant')`
  );
  const puzzleAgg = q(
    `SELECT
       SUM(CASE WHEN status='exposed' THEN 1 ELSE 0 END) exposed,
       SUM(CASE WHEN status='sealed' AND balance>0 THEN 1 ELSE 0 END) sealed
     FROM puzzle`
  );
  const sealedFundedMin = q(`SELECT MIN(n) n FROM puzzle WHERE status='sealed' AND balance>0`);
  const hits = q(`SELECT COUNT(*) c FROM hit`);

  let nodeOk = false;
  let tip: number | null = null;
  try {
    tip = await tipHeight();
    nodeOk = true;
  } catch {
    nodeOk = false;
  }

  return {
    nodeOk,
    tipHeight: tip,
    mempoolUrl: effectiveRuntime().mempoolApiUrl,
    cards: {
      dormantKnown: (dormant?.c ?? 0) > 0,
      dormantCount: dormant?.c ?? 0,
      dormantSats: dormant?.s ?? 0,
      puzzlesKnown: (puzzleAgg?.exposed ?? null) !== null && (puzzleAgg?.exposed !== undefined),
      puzzleExposed: puzzleAgg?.exposed ?? 0,
      puzzleSealed: puzzleAgg?.sealed ?? 0,
      bruteForceFrontier: sealedFundedMin?.n ? sealedFundedMin.n - 1 : 0,
      hits: hits?.c ?? 0,
      autoBuckets: effectiveRescue().autoBuckets.size
    }
  };
};
