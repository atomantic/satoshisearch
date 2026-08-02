/**
 * CLI: import a richlist file into the grinder match-set.
 *
 *   npm run index:richlist
 *   npm run index:richlist -- datasets/balances-latest.tsv.gz
 *   npm run index:richlist -- --replace datasets/balances-latest.tsv.gz
 *   npm run index:richlist -- --no-replace datasets/richlist.txt.gz
 *   npm run index:richlist -- --min-sats 100000000 path.tsv.gz
 */
import { importRichlist } from '../src/lib/server/indexer/richlist.ts';
import { effectiveRichlist } from '../src/lib/server/settings.ts';
import { arg, has, positionals } from './_args.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const argv = process.argv.slice(2);
// `--replace` is the default; only `--no-replace` opts out.
const replace = !has(argv, '--no-replace');

const richlistCfg = effectiveRichlist();
const minSatsArg = arg(argv, '--min-sats');
const minSats = minSatsArg ? Number(minSatsArg) : richlistCfg.minSats;
const source = arg(argv, '--source') || 'file';

const path =
  positionals(argv, ['--min-sats', '--source'])[0] ||
  join(root, 'datasets', 'balances-latest.tsv.gz');

// Prefer balances-latest if present, else legacy richlist
const resolved = existsSync(path)
  ? path
  : existsSync(join(root, 'datasets', 'richlist.txt.gz'))
    ? join(root, 'datasets', 'richlist.txt.gz')
    : path;

console.log(`importing ${resolved}`);
console.log(`replace=${replace} min_sats=${minSats} source=${source}`);

const started = Date.now();
const res = await importRichlist(
  resolved,
  (p) => {
    process.stdout.write(
      `\r  processed ${p.processed.toLocaleString()} · imported ${p.imported.toLocaleString()} · skipped ${p.skipped.toLocaleString()}`
    );
  },
  {
    replace,
    minSats,
    source,
    filePath: resolved,
    scriptPolicy: richlistCfg.scriptPolicy
  }
);
process.stdout.write('\n');
console.log(
  `imported ${res.imported.toLocaleString()} targets (${res.skipped.toLocaleString()} skipped) from ${res.processed.toLocaleString()} lines in ${((Date.now() - started) / 1000).toFixed(1)}s`
);
console.log('by type / skip reason:', res.byType);
console.log(`snapshot id: ${res.snapshotId}`);
