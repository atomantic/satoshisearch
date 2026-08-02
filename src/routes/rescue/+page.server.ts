import type { PageServerLoad, Actions } from './$types';
import { openDb } from '$server/db';
import { recentAudit, verifyAudit } from '$server/rescue/audit';
import { isVaultConfigured } from '$server/rescue/vault';
import { assessRescueReadiness } from '$server/rescue/readiness';
import { effectiveRescue } from '$server/settings';
import { addressLink, txLink } from '$server/links';

export const load: PageServerLoad = async () => {
  const db = openDb();

  const hits = db
    .prepare(
      `SELECT h.id, h.bucket, h.source_name, h.found_at, h.address, h.balance_at_find bal, h.status,
              c.sweep_txid txid, c.dest_address dest
       FROM hit h LEFT JOIN claim c ON c.hit_id = h.id
       ORDER BY h.found_at DESC LIMIT 100`
    )
    .all() as Array<{
    id: number;
    bucket: string;
    source_name: string;
    found_at: number;
    address: string | null;
    bal: number;
    status: string;
    txid: string | null;
    dest: string | null;
  }>;

  const totals = db
    .prepare(
      `SELECT COUNT(*) hits, COALESCE(SUM(balance_at_find),0) sats,
              SUM(CASE WHEN status='swept' THEN 1 ELSE 0 END) swept,
              SUM(CASE WHEN status='held' THEN 1 ELSE 0 END) held
       FROM hit`
    )
    .get() as { hits: number; sats: number; swept: number; held: number };

  const verification = verifyAudit();
  const audit = recentAudit(60);
  const rescue = effectiveRescue();
  const readiness = assessRescueReadiness({ primaryBucket: 'coldcard' });

  return {
    hits: hits.map((h) => ({
      ...h,
      link: h.address ? addressLink(h.address) : null,
      txLink: h.txid ? txLink(h.txid) : null
    })),
    totals,
    verification,
    audit,
    vaultReady: isVaultConfigured(),
    readiness: {
      canGrind: readiness.canGrind,
      canDryRunSweep: readiness.canDryRunSweep,
      canLiveSweep: readiness.canLiveSweep,
      matchSetSize: readiness.matchSetSize,
      richlistAgeHours: readiness.richlistAgeHours,
      nativeGrind: readiness.nativeGrind,
      primaryBucket: readiness.primaryBucket,
      checks: readiness.checks
    },
    policy: {
      dryRun: rescue.dryRun,
      dest: rescue.destAddress,
      autoBuckets: [...rescue.autoBuckets],
      whitehatAttested: rescue.whitehatAttested,
      dustSats: rescue.dustSats
    }
  };
};

export const actions: Actions = {
  verify: async () => {
    return { verification: verifyAudit() };
  }
};
