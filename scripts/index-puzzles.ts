/**
 * CLI: derive and classify all 256 puzzle targets from the node.
 *   npm run index:puzzles
 */
import { indexPuzzles } from '../src/lib/server/indexer/puzzles.ts';

const started = Date.now();
const rows = await indexPuzzles((n, total) => {
  if (n % 32 === 0 || n === total) process.stdout.write(`\r  classified ${n}/${total}`);
});
process.stdout.write('\n');

const sealed = rows.filter((r) => r.status === 'sealed');
const exposed = rows.filter((r) => r.status === 'exposed');
const solved = rows.filter((r) => r.status === 'solved');
const fundedSats = rows.reduce((a, r) => a + r.balance, 0);

console.log(`\nindexed ${rows.length} puzzles in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`  solved:  ${solved.length}`);
console.log(`  exposed: ${exposed.length} (pubkey public, kangaroo-attackable at ~N/2 bits)`);
console.log(`  sealed:  ${sealed.length} (hash160-only, full brute force at N bits)`);
console.log(`  total still funded: ${(fundedSats / 1e8).toFixed(8)} BTC`);

const sealedUnsolved = sealed.filter((r) => r.balance > 0).map((r) => r.n).sort((a, b) => a - b);
console.log(`\n  sealed + funded (the brute-force frontier): ${sealedUnsolved.join(', ') || 'none'}`);
const bruteForceFrontier = sealedUnsolved.length ? Math.min(...sealedUnsolved) - 1 : 0;
console.log(`  => demonstrated brute-force frontier: ${bruteForceFrontier} bits`);
