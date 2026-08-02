import type { PageServerLoad } from './$types';
import { analyzeKeyspace } from '$server/keyspace';
import { addressLink } from '$server/links';
import { openDb } from '$server/db';

export const load: PageServerLoad = async () => {
  const db = openDb();
  const indexed = (db.prepare('SELECT COUNT(*) c FROM puzzle').get() as { c: number }).c > 0;
  if (!indexed) return { indexed: false as const };

  const analysis = analyzeKeyspace();

  // Attach display addresses to at-risk entries.
  const addrByN = new Map(
    (
      db
        .prepare(
          `SELECT p.n n, t.address a FROM puzzle p LEFT JOIN target t ON t.id = p.target_id`
        )
        .all() as Array<{ n: number; a: string }>
    ).map((r) => [r.n, r.a])
  );

  return {
    indexed: true as const,
    analysis: {
      ...analysis,
      atRisk: analysis.atRisk.map((r) => {
        const addr = addrByN.get(r.n) ?? '';
        return { ...r, address: addr, link: addr ? addressLink(addr) : null };
      })
    }
  };
};
