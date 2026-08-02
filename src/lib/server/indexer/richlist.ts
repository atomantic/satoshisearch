/**
 * Rich-list importer — bulk-loads a large set of legacy P2PKH addresses as
 * hash160 match-set material for the grinder. Source is the ~415K address list
 * carried over from bitfinder (see datasets/PROVENANCE.md).
 *
 * These are stored hash160-only (script_hex NULL): we cannot recover a pubkey
 * from an address, so they are matched by hash160 in the grinder hot loop and
 * are never balance-swept on a schedule (that would be 415K requests/round).
 * When the grinder hits one, its balance is checked on demand before any rescue.
 */
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { openDb, nowSec } from '../db';
import { decodeBase58Address, bytesToHex } from '../script';

export interface RichlistProgress {
  processed: number;
  imported: number;
  skipped: number;
}

/** Stream a (possibly gzipped) address-per-line file and import P2PKH hash160s. */
export async function importRichlist(
  path: string,
  onProgress?: (p: RichlistProgress) => void
): Promise<RichlistProgress> {
  if (!existsSync(path)) throw new Error(`richlist file not found: ${path}`);
  const db = openDb();

  const insert = db.prepare(
    `INSERT INTO target (dataset, address, script_hex, script_type, scripthash, hash160, pubkey, height, first_balance, last_balance, last_checked_at, status)
     VALUES ('richlist', ?, NULL, 'p2pkh', NULL, ?, NULL, NULL, NULL, NULL, NULL, 'unknown')
     ON CONFLICT(dataset, address) DO NOTHING`
  );

  let processed = 0;
  let imported = 0;
  let skipped = 0;

  const raw = createReadStream(path);
  const stream = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  // Batch inside transactions for throughput; node:sqlite has no bulk API.
  let batch: Array<[string, string]> = [];
  const flush = () => {
    if (!batch.length) return;
    db.prepare('BEGIN').run();
    try {
      for (const [addr, h160] of batch) {
        const info = insert.run(addr, h160);
        if (info.changes > 0) imported++;
        else skipped++;
      }
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
    batch = [];
  };

  for await (const line of rl) {
    const addr = line.trim().split(/\s+/)[0];
    if (!addr) continue;
    processed++;
    try {
      const { version, hash } = decodeBase58Address(addr);
      if (version !== 0x00 || hash.length !== 20) {
        skipped++;
        continue; // only legacy P2PKH participate in the hash160 match-set
      }
      batch.push([addr, bytesToHex(hash)]);
    } catch {
      skipped++;
      continue;
    }
    if (batch.length >= 5000) {
      flush();
      onProgress?.({ processed, imported, skipped });
    }
  }
  flush();

  db.prepare(
    `INSERT INTO scan_run (kind, started_at, finished_at, total, processed, note)
     VALUES ('richlist-import', ?, ?, ?, ?, ?)`
  ).run(nowSec(), nowSec(), processed, imported, `from ${path}`);

  onProgress?.({ processed, imported, skipped });
  return { processed, imported, skipped };
}
