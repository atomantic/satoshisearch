/**
 * Early coinbase indexer — the P2PK-correct rebuild of the Satoshi-era address
 * set. The original crawler.js scraped btc.com for block-reward *addresses*;
 * this walks the chain on your own node and stores the real coinbase
 * scriptPubKey for each early block, so balances can be read by script hash.
 *
 * For each block height 0..COINBASE_MAX_HEIGHT it takes the coinbase tx's first
 * output (the block reward) and records:
 *   - the scriptPubKey + its type (mostly p2pk in this era) + script hash
 *   - a derived display address and hash160 (for the grinder match-set)
 * The run is resumable by height cursor via the scan_run table.
 */
import { openDb, nowSec } from '../db';
import { effectiveRuntime } from '../settings';
import { classifyScript, scriptHash } from '../script';
import { blockHashAtHeight, coinbaseTxid, getTx, tipHeight, mapPool } from '../mempool';

export interface CoinbaseProgress {
  height: number;
  target: number;
  indexed: number;
}

/** Where to resume: the max height already recorded, or -1 if none. */
function lastIndexedHeight(): number {
  const db = openDb();
  const row = db
    .prepare(`SELECT MAX(height) h FROM target WHERE dataset='coinbase'`)
    .get() as { h: number | null };
  return row.h ?? -1;
}

export async function indexCoinbase(
  maxHeight = effectiveRuntime().coinbaseMaxHeight,
  onProgress?: (p: CoinbaseProgress) => void
): Promise<{ indexed: number; from: number; to: number }> {
  const db = openDb();
  const tip = await tipHeight();
  const end = Math.min(maxHeight, tip);
  const start = lastIndexedHeight() + 1;
  if (start > end) return { indexed: 0, from: start, to: end };

  const insert = db.prepare(
    `INSERT INTO target (dataset, address, script_hex, script_type, scripthash, hash160, pubkey, height, first_balance, last_balance, last_checked_at, status)
     VALUES ('coinbase', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'unknown')
     ON CONFLICT(dataset, address) DO UPDATE SET
       script_hex = excluded.script_hex, script_type = excluded.script_type,
       scripthash = excluded.scripthash, hash160 = excluded.hash160,
       pubkey = COALESCE(excluded.pubkey, target.pubkey), height = excluded.height`
  );

  const heights = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  let indexed = 0;

  // Process in ordered chunks so the DB write batches stay sequential while the
  // network fetches within a chunk run concurrently.
  const CHUNK = 500;
  for (let c = 0; c < heights.length; c += CHUNK) {
    const chunk = heights.slice(c, c + CHUNK);
    const rows = await mapPool(chunk, async (h) => {
      const hash = await blockHashAtHeight(h);
      const txid = await coinbaseTxid(hash);
      const tx = await getTx(txid);
      const vout = tx.vout[0];
      const info = classifyScript(vout.scriptpubkey);
      return {
        h,
        address: vout.scriptpubkey_address || info.address || `coinbase-${h}`,
        scriptHex: vout.scriptpubkey,
        type: info.type,
        sh: scriptHash(vout.scriptpubkey),
        hash160: info.hash160,
        pubkey: info.pubkey
      };
    });

    const tx = db.prepare('BEGIN');
    tx.run();
    try {
      for (const r of rows) {
        insert.run(r.address, r.scriptHex, r.type, r.sh, r.hash160, r.pubkey, r.h);
        indexed++;
      }
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
    onProgress?.({ height: chunk[chunk.length - 1], target: end, indexed });
  }

  db.prepare(
    `INSERT INTO scan_run (kind, started_at, finished_at, cursor, total, processed, note)
     VALUES ('coinbase-index', ?, ?, ?, ?, ?, ?)`
  ).run(nowSec(), nowSec(), String(end), end - start + 1, indexed, `blocks ${start}-${end}`);

  return { indexed, from: start, to: end };
}
