/**
 * Stream-filter the daily loyce.club / Blockchair address+balance dump into a
 * normalized single-key richlist TSV (gzipped).
 *
 * The remote file is sorted by balance descending (sats), so we stop as soon as
 * balances fall below minSats — no need to materialize the full ~50M-address set.
 *
 * Keeps: P2PKH (1…) and P2WPKH (bc1q 20-byte). Drops: P2SH, P2WSH, P2TR, junk.
 *
 * Reading only the head of a gzip stream and then walking away is messy, and so
 * is a host that hangs up early. Three rules keep either from costing us the
 * last good snapshot:
 *   - every read-side error is captured. Killing the download at the cutoff
 *     makes gunzip raise Z_BUF_ERROR on the abandoned member; with the line
 *     iterator already detached, that surfaced as an unhandled 'error' event on
 *     the readline interface and took the whole process down.
 *   - a source that breaks *before* the cutoff means we hold a prefix of the
 *     richlist, not the richlist — that fails the fetch and is retried.
 *   - output lands in <out>.partial and is renamed over <out> only on success,
 *     so a failed fetch never replaces a complete richlist with a partial one.
 */
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
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
  /** True when we stopped on the balance cutoff rather than the end of the dump. */
  hitCutoff: boolean;
  /** Attempts used, including the successful one. */
  attempts: number;
}

export interface LoyceFetchOptions {
  url?: string;
  outPath: string;
  minSats?: number;
  onProgress?: (kept: number, seen: number) => void;
  /** Download attempts before giving up (default 3). */
  attempts?: number;
  /** Base backoff between attempts, multiplied by attempt number (default 2000ms). */
  retryDelayMs?: number;
  onRetry?: (attempt: number, attempts: number, err: Error) => void;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2000;

/**
 * Download + filter loyce dump to outPath (.tsv.gz). Returns counts.
 *
 * Retries a truncated or failed download; throws only when every attempt failed,
 * leaving any pre-existing outPath untouched.
 */
export async function fetchLoyceRichlist(opts: LoyceFetchOptions): Promise<LoyceFetchResult> {
  const richlist = effectiveRichlist();
  const url = opts.url ?? richlist.loyceUrl;
  const minSats = opts.minSats ?? richlist.minSats;
  const outPath = opts.outPath;
  const attempts = Math.max(1, Math.trunc(opts.attempts ?? DEFAULT_ATTEMPTS));
  const tmpPath = `${outPath}.partial`;

  mkdirSync(dirname(outPath), { recursive: true });

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchOnce({ url, minSats, tmpPath, onProgress: opts.onProgress });
      // Only a fully-read source earns the destination path.
      await rename(tmpPath, outPath);
      return { ...res, outPath, minSats, sourceUrl: url, attempts: attempt };
    } catch (err) {
      await rm(tmpPath, { force: true });
      if (attempt >= attempts) throw err;
      opts.onRetry?.(attempt, attempts, err as Error);
      await delay((opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) * attempt);
    }
  }
}

interface FetchOnceArgs {
  url: string;
  minSats: number;
  tmpPath: string;
  onProgress?: (kept: number, seen: number) => void;
}

async function fetchOnce(
  args: FetchOnceArgs
): Promise<{ kept: number; seen: number; skippedByType: Record<string, number>; hitCutoff: boolean }> {
  const { url, minSats, tmpPath, onProgress } = args;

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`loyce fetch failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }

  // Node fetch body → Web stream → Node Readable
  const nodeIn = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  const gunzip = createGunzip();
  const rl = createInterface({ input: nodeIn.pipe(gunzip), crlfDelay: Infinity });

  // Once we hit the cutoff we tear the download down on purpose; the resulting
  // stream errors are expected and must not fail the run.
  let aborted = false;
  // Held in an object so the assignments below (all inside callbacks) stay
  // visible to the completeness check after the loop.
  const read: { err: Error | null } = { err: null };
  // A listener on every read-side emitter: without one, an error arriving after
  // the loop has exited is an unhandled 'error' event and takes down the process.
  const capture = (err: Error) => {
    if (!aborted && !read.err) read.err = err;
  };
  nodeIn.on('error', capture);
  gunzip.on('error', capture);
  rl.on('error', capture);

  let kept = 0;
  let seen = 0;
  let hitCutoff = false;
  const skippedByType: Record<string, number> = {};

  const gzip = createGzip();
  const out = createWriteStream(tmpPath);
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
      if (balance < minSats) {
        hitCutoff = true;
        break;
      }

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
      if (kept % 50_000 === 0) onProgress?.(kept, seen);
    }
  } catch (err) {
    capture(err as Error);
  } finally {
    gzip.end();
    // Abort remaining download so we don't pull the whole multi-GB file after cutoff.
    aborted = hitCutoff;
    try {
      nodeIn.destroy();
      gunzip.destroy();
      rl.close();
    } catch {
      /* ignore */
    }
  }

  await done;

  // No cutoff and a broken source means the dump ended early: what we wrote is a
  // prefix of the richlist, not the richlist. Fail rather than publish it.
  if (!hitCutoff && read.err) {
    throw new Error(`loyce download truncated after ${seen.toLocaleString()} rows: ${read.err.message}`, {
      cause: read.err
    });
  }

  onProgress?.(kept, seen);
  return { kept, seen, skippedByType, hitCutoff };
}
