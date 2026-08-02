/**
 * Stream-filter the daily loyce.club / Blockchair address+balance dump into a
 * normalized single-key richlist TSV (gzipped).
 *
 * The remote file is sorted by balance descending (sats), so we stop as soon as
 * balances fall below minSats — no need to materialize the full ~50M-address set.
 *
 * Keeps: P2PKH (1…) and P2WPKH (bc1q 20-byte). Drops: P2SH, P2WSH, P2TR, junk.
 */
import { createWriteStream } from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeBitcoinAddress } from '../script';
import { effectiveRichlist } from '../settings';
import { RICHLIST_TSV_HEADER, formatNormalizedRow } from './richlist-format';

export interface LoyceFetchResult {
  outPath: string;
  kept: number;
  seen: number;
  skippedByType: Record<string, number>;
  minSats: number;
  sourceUrl: string;
}

export interface LoyceFetchOptions {
  url?: string;
  outPath: string;
  minSats?: number;
  onProgress?: (kept: number, seen: number) => void;
}

/**
 * Download + filter loyce dump to outPath (.tsv.gz). Returns counts.
 */
export async function fetchLoyceRichlist(opts: LoyceFetchOptions): Promise<LoyceFetchResult> {
  const richlist = effectiveRichlist();
  const url = opts.url ?? richlist.loyceUrl;
  const minSats = opts.minSats ?? richlist.minSats;
  const outPath = opts.outPath;

  mkdirSync(dirname(outPath), { recursive: true });

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`loyce fetch failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }

  // Node fetch body → Web stream → Node Readable
  const nodeIn = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  const gunzip = createGunzip();
  const rl = createInterface({ input: nodeIn.pipe(gunzip), crlfDelay: Infinity });

  let kept = 0;
  let seen = 0;
  const skippedByType: Record<string, number> = {};

  const gzip = createGzip();
  const out = createWriteStream(outPath);
  const done = pipeline(gzip, out);

  gzip.write(RICHLIST_TSV_HEADER);
  gzip.write(`# source=${url}\n`);
  gzip.write(`# min_sats=${minSats}\n`);
  gzip.write(`# script_policy=p2pkh,p2wpkh\n`);
  gzip.write(`# fetched_at=${new Date().toISOString()}\n`);

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^address\b/i.test(trimmed)) continue;

      // Tab and space separated both fall out of one split — an address never
      // contains whitespace.
      const [address, balStr = '0'] = trimmed.split(/\s+/);

      const balance = Number(balStr);
      if (!Number.isFinite(balance)) continue;
      seen++;

      // Sorted high→low: stop once under threshold.
      if (balance < minSats) break;

      const decoded = decodeBitcoinAddress(address);
      if (!decoded || !decoded.hash160) {
        const k = decoded?.type ?? 'decode';
        skippedByType[k] = (skippedByType[k] ?? 0) + 1;
        continue;
      }
      if (decoded.type !== 'p2pkh' && decoded.type !== 'p2wpkh') {
        skippedByType[decoded.type] = (skippedByType[decoded.type] ?? 0) + 1;
        continue;
      }

      gzip.write(formatNormalizedRow(address, decoded.type, decoded.hash160, Math.trunc(balance)));
      kept++;
      if (kept % 50_000 === 0) opts.onProgress?.(kept, seen);
    }
  } finally {
    gzip.end();
    // Abort remaining download so we don't pull the whole multi-GB file after cutoff.
    try {
      nodeIn.destroy();
    } catch {
      /* ignore */
    }
  }

  await done;
  opts.onProgress?.(kept, seen);

  return { outPath, kept, seen, skippedByType, minSats, sourceUrl: url };
}
