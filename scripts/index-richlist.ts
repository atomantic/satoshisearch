/**
 * CLI: import the rich-list into the grinder match-set.
 *   npm run index:richlist                      # default datasets/richlist.txt.gz
 *   npm run index:richlist -- path/to/list.txt
 */
import { importRichlist } from '../src/lib/server/indexer/richlist.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] || join(here, '..', 'datasets', 'richlist.txt.gz');

const started = Date.now();
const res = await importRichlist(path, (p) => {
  process.stdout.write(`\r  processed ${p.processed} · imported ${p.imported} · skipped ${p.skipped}`);
});
process.stdout.write('\n');
console.log(
  `imported ${res.imported} hash160 targets (${res.skipped} skipped) from ${res.processed} lines in ${((Date.now() - started) / 1000).toFixed(1)}s`
);
