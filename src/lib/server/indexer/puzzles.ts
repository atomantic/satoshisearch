/**
 * Bitcoin puzzle indexer — derives all 256 puzzle targets entirely from the
 * chain, no scraping of btcpuzzle.info.
 *
 * All 256 addresses are the outputs of a single 2015 funding transaction
 * (PUZZLE_FUNDING_TXID, block 339085): vout[N-1] is puzzle N, and its private
 * key lies in [2^(N-1), 2^N). Status is classified from live node data:
 *
 *   solved   — balance 0 (swept)
 *   exposed  — funded AND the address has a spending input somewhere, so its
 *              pubkey is public → attackable by Pollard's kangaroo at ~N/2 bits
 *   sealed   — funded, never spent from → only the address (hash160) is known,
 *              so it needs a full brute force at N bits
 *
 * The sealed/unsolved set is the true brute-force frontier. As probed, 71 and 72
 * are the only sealed-unsolved puzzles, which is exactly where the 2026 ColdCard
 * 72-bit entropy flaw sits.
 */
import { openDb, nowSec } from '../db';
import { config, PUZZLE_FUNDING_TXID } from '../config';
import { classifyScript, scriptHash } from '../script';
import { getTx, scriptStatus, scriptTxsAll, mapPool, type Tx } from '../mempool';

export type PuzzleStatus = 'sealed' | 'exposed' | 'solved';

export interface PuzzleRow {
  n: number;
  address: string;
  scriptHex: string;
  rangeLo: string;
  rangeHi: string;
  status: PuzzleStatus;
  pubkeyExposed: boolean;
  balance: number;
  solveTxid: string | null;
  solveHeight: number | null;
}

/** Fetch the funding tx and derive the 256 (address, scriptPubKey, range) tuples. */
export async function derivePuzzleTargets(): Promise<
  Array<{ n: number; address: string; scriptHex: string; rangeLo: string; rangeHi: string }>
> {
  const tx = await getTx(PUZZLE_FUNDING_TXID);
  if (tx.vout.length < 256) {
    throw new Error(`Funding tx has only ${tx.vout.length} outputs; expected >= 256`);
  }
  const out: Array<{ n: number; address: string; scriptHex: string; rangeLo: string; rangeHi: string }> = [];
  for (let n = 1; n <= 256; n++) {
    const vout = tx.vout[n - 1];
    const c = classifyScript(vout.scriptpubkey);
    out.push({
      n,
      address: vout.scriptpubkey_address || c.address || '',
      scriptHex: vout.scriptpubkey,
      rangeLo: (1n << BigInt(n - 1)).toString(16),
      rangeHi: ((1n << BigInt(n)) - 1n).toString(16)
    });
  }
  return out;
}

/**
 * Classify one puzzle from the node: balance via script hash, and whether any
 * input has ever spent from it (pubkey exposure). Extracts the revealed pubkey
 * and the solving tx when present.
 */
export async function classifyPuzzle(scriptHex: string): Promise<{
  status: PuzzleStatus;
  pubkeyExposed: boolean;
  balance: number;
  pubkey: string | null;
  solveTxid: string | null;
  solveHeight: number | null;
}> {
  const status = await scriptStatus(scriptHex);
  const balance = status.chain_stats.funded_txo_sum - status.chain_stats.spent_txo_sum;

  // Exposure MUST come from scanning inputs, not chain_stats counts. The dev
  // node's electrs runs in a lightweight mode that reports spent_txo_count and
  // spent_txo_sum as 0 for every script (verified: puzzles 140/160 are provably
  // spent-from yet report spent_txo_count=0). funded_txo_sum still equals the
  // true net balance (matches public mempool.space exactly), so balance is fine;
  // only the spend flag is unusable. We paginate so a spend hidden behind the
  // 50-tx page window (p71 has 53 txs) is not missed.
  const txs = await scriptTxsAll(scriptHex);
  const spend = findSpend(txs, scriptHex);
  const everSpent = spend !== null;

  const status_: PuzzleStatus = balance === 0 ? 'solved' : everSpent ? 'exposed' : 'sealed';
  return {
    status: status_,
    pubkeyExposed: everSpent,
    balance,
    pubkey: spend?.pubkey ?? null,
    solveTxid: spend?.txid ?? null,
    solveHeight: spend?.height ?? null
  };
}

/** Locate the input that spends this script and pull the revealed pubkey out of it. */
function findSpend(
  txs: Tx[],
  scriptHex: string
): { txid: string; height: number | null; pubkey: string | null } | null {
  const targetHash = scriptHex.toLowerCase();
  for (const tx of txs) {
    for (const vin of tx.vin) {
      if (!vin.prevout) continue;
      if (vin.prevout.scriptpubkey?.toLowerCase() !== targetHash) continue;
      let pubkey: string | null = null;
      // Legacy P2PKH: scriptsig ends with the 33/65-byte pubkey push.
      const asm = vin.scriptsig_asm || '';
      const m = asm.match(/OP_PUSHBYTES_(?:33|65)\s+([0-9a-f]+)\s*$/i);
      if (m) pubkey = m[1];
      // SegWit: witness[last] is the pubkey.
      if (!pubkey && vin.witness && vin.witness.length) pubkey = vin.witness[vin.witness.length - 1];
      return { txid: tx.txid, height: tx.status.block_height ?? null, pubkey };
    }
  }
  return null;
}

/** Full index: derive targets, classify each, upsert target + puzzle rows. */
export async function indexPuzzles(
  onProgress?: (n: number, total: number) => void
): Promise<PuzzleRow[]> {
  const db = openDb();
  const targets = await derivePuzzleTargets();
  const rows: PuzzleRow[] = [];

  const upsertTarget = db.prepare(
    `INSERT INTO target (dataset, address, script_hex, script_type, scripthash, hash160, pubkey, height, first_balance, last_balance, last_checked_at, status)
     VALUES ('puzzle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dataset, address) DO UPDATE SET
       last_balance = excluded.last_balance,
       pubkey = COALESCE(excluded.pubkey, target.pubkey),
       last_checked_at = excluded.last_checked_at,
       status = excluded.status
     RETURNING id`
  );
  const upsertPuzzle = db.prepare(
    `INSERT INTO puzzle (n, target_id, range_lo, range_hi, status, pubkey_exposed, balance, solve_txid, solve_height, solved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(n) DO UPDATE SET
       target_id = excluded.target_id, status = excluded.status,
       pubkey_exposed = excluded.pubkey_exposed, balance = excluded.balance,
       solve_txid = excluded.solve_txid, solve_height = excluded.solve_height,
       solved_at = COALESCE(excluded.solved_at, puzzle.solved_at)`
  );

  // Classify over the network in parallel (bounded concurrency); the pagination
  // for exposed puzzles makes this the slow part. DB writes stay single-threaded
  // afterward, since node:sqlite is synchronous and not thread-safe.
  let done = 0;
  const classified = await mapPool(targets, async (t) => {
    const info = await classifyPuzzle(t.scriptHex);
    onProgress?.(++done, targets.length);
    return { t, info };
  });

  const now = nowSec();
  const writeAll = db.prepare('BEGIN');
  writeAll.run();
  try {
    for (const { t, info } of classified) {
      const c = classifyScript(t.scriptHex);
      const targetStatus = info.balance === 0 ? 'empty' : info.pubkeyExposed ? 'moved' : 'untouched';
      const res = upsertTarget.get(
        t.address,
        t.scriptHex,
        c.type,
        scriptHash(t.scriptHex), // stored for reference; lookups recompute from script_hex
        c.hash160,
        info.pubkey,
        null,
        info.balance,
        info.balance,
        now,
        targetStatus
      ) as { id: number };
      upsertPuzzle.run(
        t.n,
        res.id,
        t.rangeLo,
        t.rangeHi,
        info.status,
        info.pubkeyExposed ? 1 : 0,
        info.balance,
        info.solveTxid,
        info.solveHeight,
        info.status === 'solved' ? now : null
      );
      rows.push({
        n: t.n,
        address: t.address,
        scriptHex: t.scriptHex,
        rangeLo: t.rangeLo,
        rangeHi: t.rangeHi,
        status: info.status,
        pubkeyExposed: info.pubkeyExposed,
        balance: info.balance,
        solveTxid: info.solveTxid,
        solveHeight: info.solveHeight
      });
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  rows.sort((a, b) => a.n - b.n);
  return rows;
}

/** Read the indexed puzzle rows for display (no network). */
export function getPuzzleRows(): PuzzleRow[] {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT p.n, t.address, t.script_hex AS scriptHex, p.range_lo AS rangeLo, p.range_hi AS rangeHi,
              p.status, p.pubkey_exposed AS pubkeyExposed, p.balance, p.solve_txid AS solveTxid, p.solve_height AS solveHeight
       FROM puzzle p LEFT JOIN target t ON t.id = p.target_id
       ORDER BY p.n`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    n: Number(r.n),
    address: String(r.address ?? ''),
    scriptHex: String(r.scriptHex ?? ''),
    rangeLo: String(r.rangeLo),
    rangeHi: String(r.rangeHi),
    status: r.status as PuzzleStatus,
    pubkeyExposed: Boolean(r.pubkeyExposed),
    balance: Number(r.balance ?? 0),
    solveTxid: (r.solveTxid as string) ?? null,
    solveHeight: r.solveHeight == null ? null : Number(r.solveHeight)
  }));
}
