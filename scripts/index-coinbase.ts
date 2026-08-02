/**
 * CLI: walk early blocks and record each coinbase output (P2PK-correct).
 *   npm run index:coinbase              # up to COINBASE_MAX_HEIGHT (default 50000)
 *   COINBASE_MAX_HEIGHT=2000 npm run index:coinbase
 */
import { indexCoinbase } from '../src/lib/server/indexer/coinbase.ts';

const started = Date.now();
const res = await indexCoinbase(undefined, (p) => {
  process.stdout.write(`\r  indexed ${p.indexed} (block ${p.height}/${p.target})`);
});
process.stdout.write('\n');
console.log(
  `indexed ${res.indexed} coinbase outputs (blocks ${res.from}-${res.to}) in ${((Date.now() - started) / 1000).toFixed(1)}s`
);
