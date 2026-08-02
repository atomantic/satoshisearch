import type { PageServerLoad } from './$types';
import { getPuzzleRows } from '$server/indexer/puzzles';
import { addressLink, txLink } from '$server/links';

export const load: PageServerLoad = async () => {
  const rows = getPuzzleRows();

  const solved = rows.filter((r) => r.status === 'solved');
  const exposed = rows.filter((r) => r.status === 'exposed');
  const sealed = rows.filter((r) => r.status === 'sealed');
  const fundedSats = rows.reduce((a, r) => a + r.balance, 0);
  const atRiskSats = exposed.reduce((a, r) => a + r.balance, 0);

  // The demonstrated brute-force frontier: the largest N such that every sealed
  // puzzle at or below N has been solved. Sealed+funded puzzles start just above.
  const sealedFundedNs = sealed.filter((r) => r.balance > 0).map((r) => r.n).sort((a, b) => a - b);
  const bruteForceFrontier = sealedFundedNs.length ? Math.min(...sealedFundedNs) - 1 : 0;

  return {
    rows: rows.map((r) => ({
      ...r,
      addressLink: r.address ? addressLink(r.address) : null,
      solveLink: r.solveTxid ? txLink(r.solveTxid) : null
    })),
    indexed: rows.length > 0,
    stats: {
      solved: solved.length,
      exposed: exposed.length,
      sealed: sealed.length,
      fundedSats,
      atRiskSats,
      bruteForceFrontier,
      sealedFundedNs
    }
  };
};
