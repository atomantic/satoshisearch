/**
 * Stream-filter the daily loyce.club address+balance dump into a normalized
 * single-key richlist for the grinder.
 *
 *   npm run richlist:fetch
 *   npm run richlist:fetch -- --min-btc 0.1 --out datasets/balances-latest.tsv.gz
 *   npm run richlist:fetch -- --min-sats 100000000
 */
import { fetchLoyceRichlist } from '../src/lib/server/indexer/loyce.ts';
import { effectiveRichlist } from '../src/lib/server/settings.ts';
import { arg } from './_args.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const argv = process.argv.slice(2);
const richlistCfg = effectiveRichlist();

const minBtc = arg(argv, '--min-btc');
const minSatsArg = arg(argv, '--min-sats');
const minSats = minSatsArg
  ? Number(minSatsArg)
  : minBtc
    ? Math.round(Number(minBtc) * 1e8)
    : richlistCfg.minSats;

if (!Number.isFinite(minSats) || minSats < 0) {
  console.error('invalid min balance');
  process.exit(1);
}

const out = arg(argv, '--out') || join(root, 'datasets', 'balances-latest.tsv.gz');
const url = arg(argv, '--url') || richlistCfg.loyceUrl;

mkdirSync(dirname(out), { recursive: true });

console.log(`fetching ${url}`);
console.log(`min_sats=${minSats} (${(minSats / 1e8).toFixed(4)} BTC) → ${out}`);

const started = Date.now();
const res = await fetchLoyceRichlist({
  url,
  outPath: out,
  minSats,
  onProgress: (kept, seen) => {
    process.stdout.write(`\r  kept ${kept.toLocaleString()} · scanned ${seen.toLocaleString()}`);
  }
});
process.stdout.write('\n');

console.log(
  `wrote ${res.kept.toLocaleString()} single-key rows (scanned ${res.seen.toLocaleString()} funded ≥ min) in ${((Date.now() - started) / 1000).toFixed(1)}s`
);
console.log('skipped by type:', res.skippedByType);
console.log(`\nnext: npm run index:richlist -- --replace ${out}`);
