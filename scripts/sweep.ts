/**
 * CLI: sweep (read balances for) the Satoshi-era coinbase set and report moves.
 *   npm run sweep
 *   npm run sweep -- --funded     # only re-check known-funded targets (fast)
 */
import { sweep } from '../src/lib/server/sweep.ts';

const onlyFunded = process.argv.includes('--funded');
const res = await sweep({
  onlyFunded,
  onProgress: (done, total) => {
    if (done % 500 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
  }
});
process.stdout.write('\n');
console.log(
  `swept ${res.scanned} targets in ${(res.elapsedMs / 1000).toFixed(1)}s · ${res.changed} changed`
);
if (res.moved.length) {
  console.log(`\n⚠ ${res.moved.length} target(s) LOST balance since last check:`);
  for (const m of res.moved) {
    console.log(`  ${m.address}: ${(m.oldBalance / 1e8).toFixed(8)} → ${(m.newBalance / 1e8).toFixed(8)} BTC`);
  }
} else {
  console.log('no dormant coins moved. Satoshi still sleeps. 😴');
}
