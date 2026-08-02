/**
 * Phase 2: Bitcoin Core UTXO dump → single-key richlist.
 *
 * dumptxoutset writes on the **node host**. Typical Umbrel workflow:
 *
 *   # 1) On the node (or via RPC from here if path is on that host):
 *   bitcoin-cli dumptxoutset /data/utxo-2026-08-02.dat
 *   # 2) Copy the file here, then:
 *   npm run richlist:from-utxo -- --file /path/to/utxo.dat --import
 *
 * Or request the dump over RPC (file lands on Core's datadir):
 *   npm run richlist:from-utxo -- --rpc-dump satoshisearch-utxo.dat
 *
 * Env: BITCOIN_RPC_URL, BITCOIN_RPC_USER/PASSWORD or BITCOIN_RPC_COOKIE,
 *      RICHLIST_MIN_SATS
 */
import { aggregateUtxoDumpFile, writeAggregatedRichlist } from '../src/lib/server/bitcoin/utxo-dump.ts';
import {
  dumpTxOutSet,
  getBlockchainInfo,
  isRpcConfigured,
  resolveRpcAuth
} from '../src/lib/server/bitcoin/rpc.ts';
import { importRichlist } from '../src/lib/server/indexer/richlist.ts';
import { effectiveRichlist } from '../src/lib/server/settings.ts';
import { arg, has } from './_args.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const argv = process.argv.slice(2);

const minBtc = arg(argv, '--min-btc');
const minSatsArg = arg(argv, '--min-sats');
const minSats = minSatsArg
  ? Number(minSatsArg)
  : minBtc
    ? Math.round(Number(minBtc) * 1e8)
    : effectiveRichlist().minSats;

const outPath = arg(argv, '--out') || join(root, 'datasets', 'balances-latest.tsv.gz');
const doImport = has(argv, '--import');
const rpcDumpName = arg(argv, '--rpc-dump');
const file = arg(argv, '--file');

async function main(): Promise<void> {
  if (rpcDumpName) {
    // resolveRpcAuth throws with a clear message when nothing is configured.
    const auth = resolveRpcAuth();
    console.log(`RPC ${auth.url} → dumptxoutset ${rpcDumpName}`);
    console.log('(file is written on the Bitcoin Core host, relative to its datadir unless absolute)');
    const info = await getBlockchainInfo(auth);
    console.log(`chain tip height=${info.blocks} hash=${info.bestblockhash}`);
    const started = Date.now();
    const res = await dumpTxOutSet(rpcDumpName, auth);
    console.log(
      `dump done in ${((Date.now() - started) / 1000).toFixed(1)}s: coins=${res.coins_written} height=${res.base_height}`
    );
    console.log(`remote path: ${res.path}`);
    console.log(`base_hash: ${res.base_hash}`);
    console.log(`\nNext: copy that file here, then:\n  npm run richlist:from-utxo -- --file <local-copy> --import`);
    return;
  }

  if (!file) {
    console.error(`Usage:
  npm run richlist:from-utxo -- --file /path/to/utxo.dat [--out datasets/balances-latest.tsv.gz] [--import]
  npm run richlist:from-utxo -- --rpc-dump satoshisearch-utxo.dat

Options:
  --min-btc N | --min-sats N   balance floor (default ${effectiveRichlist().minSats})
  --import                     run index:richlist --replace after writing TSV
`);
    process.exit(1);
  }

  if (!existsSync(file)) {
    console.error(`file not found: ${file}`);
    process.exit(1);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  console.log(`parsing ${file}`);
  console.log(`min_sats=${minSats} → ${outPath}`);

  const started = Date.now();
  const agg = await aggregateUtxoDumpFile(file, {
    minSats,
    onProgress: (coins, kept) => {
      process.stdout.write(`\r  coins ${coins.toLocaleString()} · scripts≥min ${kept.toLocaleString()}`);
    }
  });
  process.stdout.write('\n');

  const { kept } = await writeAggregatedRichlist(agg, {
    outPath,
    minSats,
    source: 'core-utxo',
    tipHeight: null
  });

  console.log(
    `parsed ${agg.coinsRead.toLocaleString()} coins → ${kept.toLocaleString()} single-key scripts ≥ min in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  console.log(`tip hash (snapshot base): ${agg.header.tipHashHex}`);
  console.log('skipped by type:', agg.skippedByType);

  // Try to resolve tip height via RPC if configured
  let tipHeight: number | null = null;
  const tipHash = agg.header.tipHashHex;
  if (isRpcConfigured()) {
    try {
      const info = await getBlockchainInfo();
      tipHeight = info.blocks;
      // Prefer snapshot hash; height from live tip is approximate if not same block
      console.log(`live tip height=${info.blocks} (snapshot base may lag tip slightly)`);
    } catch (e) {
      console.warn(`RPC tip lookup skipped: ${e}`);
    }
  }

  if (doImport) {
    console.log(`importing ${outPath} …`);
    const res = await importRichlist(
      outPath,
      (p) => {
        process.stdout.write(
          `\r  processed ${p.processed.toLocaleString()} · imported ${p.imported.toLocaleString()}`
        );
      },
      {
        replace: true,
        source: 'core-utxo',
        tipHeight,
        tipHash,
        minSats,
        filePath: outPath,
        note: `from dumptxoutset tip=${tipHash}`
      }
    );
    process.stdout.write('\n');
    console.log(
      `imported ${res.imported.toLocaleString()} targets; snapshot #${res.snapshotId}; by type:`,
      res.byType
    );
  } else {
    console.log(`\nnext: npm run index:richlist -- --replace ${outPath} --source core-utxo`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
