/**
 * Rich-list importer — bulk-loads funded single-key addresses as grinder
 * match-set material, with optional snapshot balances.
 *
 * Accepts:
 *   1. Normalized TSV (preferred):
 *        address \t script_type \t match_kind \t match_hex \t balance_sats \t script_hex?
 *   2. Loyce / address+balance: address \t balance_sats  (or space-separated)
 *   3. Legacy address-per-line (no balances) — still imported as hash160-only
 *
 * Script policy (single-key only): p2pkh + p2wpkh by default. P2SH / P2WSH /
 * bare multisig / P2TR are skipped (see plans/richlist-refresh.md).
 *
 * Default strategy is full replace of dataset='richlist' so the match-set tracks
 * the latest snapshot. Hits that pointed at old richlist rows have target_id
 * cleared first so foreign keys stay happy.
 */
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { openDb, nowSec } from '../db';
import {
  decodeBitcoinAddress,
  p2pkhScript,
  p2wpkhScript,
  scriptHash,
  type ScriptType
} from '../script';
import { effectiveRichlist } from '../settings';

export interface RichlistProgress {
  processed: number;
  imported: number;
  skipped: number;
  byType: Record<string, number>;
}

export interface RichlistImportOptions {
  /** Drop existing richlist targets before insert (default true). */
  replace?: boolean;
  /** Snapshot provenance for richlist_snapshot. */
  source?: string;
  tipHeight?: number | null;
  tipHash?: string | null;
  minSats?: number;
  scriptPolicy?: string;
  filePath?: string;
  note?: string;
}

export interface RichlistRow {
  address: string;
  scriptType: ScriptType;
  /** Present for p2pkh / p2wpkh. */
  hash160: string | null;
  /** Present for p2pk (raw pubkey hex). */
  pubkey: string | null;
  balanceSats: number | null;
  scriptHex: string;
}

/** Parse one data line into a keepable richlist row, or null if skip. */
export function parseRichlistLine(line: string): { row: RichlistRow | null; skipReason?: string } {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return { row: null, skipReason: 'empty' };

  // Normalized header
  if (/^address\b/i.test(trimmed) && /balance/i.test(trimmed)) {
    return { row: null, skipReason: 'header' };
  }

  const parts = trimmed.split(/\t+/);
  // Also allow space-separated address balance (legacy bitfinder style)
  const fields = parts.length >= 2 ? parts : trimmed.split(/\s+/);

  let address: string;
  let scriptType: ScriptType | null = null;
  let hash160: string | null = null;
  let pubkey: string | null = null;
  let balanceSats: number | null = null;
  let scriptHex: string | null = null;

  if (fields.length >= 5 && (fields[2] === 'hash160' || fields[2] === 'pubkey')) {
    // normalized: address, script_type, match_kind, match_hex, balance_sats, [script_hex]
    address = fields[0];
    scriptType = fields[1] as ScriptType;
    const matchKind = fields[2];
    const matchHex = fields[3].toLowerCase();
    balanceSats = Number(fields[4]);
    if (!Number.isFinite(balanceSats)) balanceSats = null;
    scriptHex = fields[5]?.trim() || null;
    if (matchKind === 'hash160') hash160 = matchHex;
    else if (matchKind === 'pubkey') pubkey = matchHex;
  } else {
    // address [balance]
    address = fields[0];
    if (fields[1] !== undefined && fields[1] !== '') {
      const b = Number(fields[1]);
      if (Number.isFinite(b)) balanceSats = Math.trunc(b);
    }
    const decoded = decodeBitcoinAddress(address);
    if (!decoded) return { row: null, skipReason: 'decode' };
    scriptType = decoded.type;
    hash160 = decoded.hash160;
  }

  if (!scriptType) return { row: null, skipReason: 'no-type' };

  // Single-key policy.
  if (scriptType === 'p2pk') {
    if (!pubkey || (pubkey.length !== 66 && pubkey.length !== 130)) {
      return { row: null, skipReason: 'bad-pubkey' };
    }
    if (!scriptHex) {
      // Reconstruct from pubkey length
      const push = (pubkey.length / 2).toString(16).padStart(2, '0');
      scriptHex = `${push}${pubkey}ac`;
    }
    return {
      row: {
        address: address || `p2pk:${pubkey.slice(0, 16)}`,
        scriptType,
        hash160: null,
        pubkey,
        balanceSats,
        scriptHex: scriptHex.toLowerCase()
      }
    };
  }

  if (scriptType !== 'p2pkh' && scriptType !== 'p2wpkh') {
    return { row: null, skipReason: scriptType };
  }

  if (!hash160 || hash160.length !== 40) {
    return { row: null, skipReason: 'no-hash160' };
  }

  if (!scriptHex) {
    scriptHex = scriptType === 'p2wpkh' ? p2wpkhScript(hash160) : p2pkhScript(hash160);
  }

  return {
    row: {
      address,
      scriptType,
      hash160: hash160.toLowerCase(),
      pubkey: null,
      balanceSats,
      scriptHex: scriptHex.toLowerCase()
    }
  };
}

/** Stream a (possibly gzipped) richlist file and import into target. */
export async function importRichlist(
  path: string,
  onProgress?: (p: RichlistProgress) => void,
  opts: RichlistImportOptions = {}
): Promise<RichlistProgress & { snapshotId: number | null }> {
  if (!existsSync(path)) throw new Error(`richlist file not found: ${path}`);
  const db = openDb();
  const replace = opts.replace !== false;
  const minSats = opts.minSats ?? effectiveRichlist().minSats;
  const now = nowSec();

  const progress: RichlistProgress = {
    processed: 0,
    imported: 0,
    skipped: 0,
    byType: {}
  };

  if (replace) {
    // Clear FKs then drop prior richlist rows.
    db.prepare(
      `DELETE FROM balance_event WHERE target_id IN (SELECT id FROM target WHERE dataset='richlist')`
    ).run();
    db.prepare(
      `UPDATE hit SET target_id = NULL WHERE target_id IN (SELECT id FROM target WHERE dataset='richlist')`
    ).run();
    db.prepare(`DELETE FROM target WHERE dataset='richlist'`).run();
  }

  const insert = db.prepare(
    `INSERT INTO target (dataset, address, script_hex, script_type, scripthash, hash160, pubkey, height, first_balance, last_balance, last_checked_at, status)
     VALUES ('richlist', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'unknown')
     ON CONFLICT(dataset, address) DO UPDATE SET
       script_hex = excluded.script_hex,
       script_type = excluded.script_type,
       scripthash = excluded.scripthash,
       hash160 = excluded.hash160,
       pubkey = excluded.pubkey,
       first_balance = COALESCE(target.first_balance, excluded.first_balance),
       last_balance = excluded.last_balance,
       last_checked_at = excluded.last_checked_at,
       status = excluded.status`
  );

  const raw = createReadStream(path);
  const stream = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  type BatchRow = [
    string,
    string,
    string,
    string,
    string | null,
    string | null,
    number | null,
    number | null,
    number
  ];
  let batch: BatchRow[] = [];

  const flush = () => {
    if (!batch.length) return;
    db.prepare('BEGIN').run();
    try {
      for (const row of batch) {
        const info = insert.run(...row);
        if (info.changes > 0) progress.imported++;
        else progress.skipped++;
      }
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
    batch = [];
  };

  for await (const line of rl) {
    progress.processed++;
    const { row, skipReason } = parseRichlistLine(line);
    if (!row) {
      progress.skipped++;
      if (skipReason && skipReason !== 'header' && skipReason !== 'empty') {
        progress.byType[skipReason] = (progress.byType[skipReason] ?? 0) + 1;
      }
      continue;
    }
    if (row.balanceSats !== null && row.balanceSats < minSats) {
      progress.skipped++;
      progress.byType['below-min'] = (progress.byType['below-min'] ?? 0) + 1;
      continue;
    }

    progress.byType[row.scriptType] = (progress.byType[row.scriptType] ?? 0) + 1;
    const sh = scriptHash(row.scriptHex);
    batch.push([
      row.address,
      row.scriptHex,
      row.scriptType,
      sh,
      row.hash160,
      row.pubkey,
      row.balanceSats,
      row.balanceSats,
      now
    ]);

    if (batch.length >= 5000) {
      flush();
      onProgress?.(progress);
    }
  }
  flush();
  onProgress?.(progress);

  const policy = opts.scriptPolicy ?? effectiveRichlist().scriptPolicy;
  const source = opts.source ?? 'file';
  const snap = db
    .prepare(
      `INSERT INTO richlist_snapshot (source, created_at, tip_height, tip_hash, min_sats, script_policy, row_count, file_path, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      source,
      now,
      opts.tipHeight ?? null,
      opts.tipHash ?? null,
      minSats,
      policy,
      progress.imported,
      opts.filePath ?? path,
      opts.note ?? `imported ${progress.imported} of ${progress.processed} lines`
    ) as { id: number };

  db.prepare(
    `INSERT INTO scan_run (kind, started_at, finished_at, total, processed, note)
     VALUES ('richlist-import', ?, ?, ?, ?, ?)`
  ).run(now, now, progress.processed, progress.imported, `from ${path}; snapshot #${snap.id}`);

  return { ...progress, snapshotId: snap.id };
}
