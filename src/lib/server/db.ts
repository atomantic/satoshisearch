/**
 * SQLite persistence, on top of the built-in `node:sqlite` (zero native deps —
 * verified working on Node 22+/24). A single database file under DATA_DIR holds
 * the indexed chain targets, balance history, puzzle state, grinder progress,
 * rescue hits, the hash-chained audit log, and owner-claim records.
 *
 * The schema is created idempotently on first access via a tiny migration list,
 * so `openDb()` is safe to call from any entry point (web request, index script,
 * sweep worker).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config';

let _db: DatabaseSync | null = null;

/** Ordered, append-only schema migrations. Never edit a past entry; add a new one. */
const MIGRATIONS: string[] = [
  // 1 — targets: every address/script we watch, across all datasets.
  `CREATE TABLE IF NOT EXISTS target (
    id           INTEGER PRIMARY KEY,
    dataset      TEXT NOT NULL,              -- coinbase | dormant | puzzle | richlist
    address      TEXT,                       -- display address (P2PK has a derived one)
    script_hex   TEXT,                       -- real scriptPubKey; NULL for hash160-only richlist
    script_type  TEXT,                       -- p2pk | p2pkh | ...
    scripthash   TEXT,                       -- sha256(scriptPubKey), forward hex; the balance key
    hash160      TEXT,                       -- 20-byte hash160 hex, for grinder matching
    pubkey       TEXT,                       -- raw pubkey hex when known (P2PK / spent inputs)
    height       INTEGER,                    -- source block height where relevant
    first_balance INTEGER,                   -- sats at first observation
    last_balance  INTEGER,                   -- sats at last check
    last_checked_at INTEGER,                 -- unix seconds
    status       TEXT DEFAULT 'unknown'      -- untouched | moved | empty | unknown
  )`,
  `CREATE INDEX IF NOT EXISTS idx_target_dataset ON target(dataset)`,
  `CREATE INDEX IF NOT EXISTS idx_target_scripthash ON target(scripthash)`,
  `CREATE INDEX IF NOT EXISTS idx_target_hash160 ON target(hash160)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_target_addr_dataset ON target(dataset, address)`,

  // 2 — balance_event: append-only history; drives "a Satoshi-era coin moved" alerts.
  `CREATE TABLE IF NOT EXISTS balance_event (
    id          INTEGER PRIMARY KEY,
    target_id   INTEGER NOT NULL REFERENCES target(id),
    ts          INTEGER NOT NULL,
    height      INTEGER,
    old_balance INTEGER,
    new_balance INTEGER,
    txid        TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_balevent_target ON balance_event(target_id)`,

  // 3 — puzzle: derived-from-chain state for all 256 puzzle outputs.
  `CREATE TABLE IF NOT EXISTS puzzle (
    n              INTEGER PRIMARY KEY,       -- 1..256
    target_id      INTEGER REFERENCES target(id),
    range_lo       TEXT NOT NULL,             -- hex 2^(n-1)
    range_hi       TEXT NOT NULL,             -- hex 2^n - 1
    status         TEXT NOT NULL,             -- sealed | exposed | solved
    pubkey_exposed INTEGER NOT NULL DEFAULT 0,
    balance        INTEGER,
    solved_at      INTEGER,
    solve_txid     TEXT,
    solve_height   INTEGER
  )`,

  // 4 — scan_run: bookkeeping for sweeps and index runs.
  `CREATE TABLE IF NOT EXISTS scan_run (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL,               -- coinbase-index | puzzle-index | sweep | richlist-import
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    cursor      TEXT,                        -- resumable position (e.g. block height)
    total       INTEGER,
    processed   INTEGER DEFAULT 0,
    note        TEXT
  )`,

  // 5 — grind_source: registered candidate-key generators and their progress.
  `CREATE TABLE IF NOT EXISTS grind_source (
    name       TEXT PRIMARY KEY,            -- puzzle-range | brainwallet | constants | lowentropy | coldcard
    bucket     TEXT NOT NULL,               -- sweep classification
    config_json TEXT,
    space_bits REAL,                        -- log2 of the searchable space (may be fractional/estimate)
    cursor     TEXT,                        -- resumable position within the space
    keys_tried INTEGER DEFAULT 0,
    enabled    INTEGER DEFAULT 0
  )`,

  // 6 — hit: a generated key that matched a funded target.
  `CREATE TABLE IF NOT EXISTS hit (
    id             INTEGER PRIMARY KEY,
    target_id      INTEGER REFERENCES target(id),
    source_name    TEXT,
    bucket         TEXT NOT NULL,
    found_at       INTEGER NOT NULL,
    address        TEXT,
    privkey_enc    TEXT NOT NULL,           -- AES-256-GCM ciphertext; never plaintext
    balance_at_find INTEGER,
    status         TEXT NOT NULL DEFAULT 'held'  -- held | swept | dry-run | failed | ignored
  )`,

  // 7 — audit: hash-chained, append-only. Tamper-evident record of everything
  //     security-relevant (hits, sweeps, config changes). See rescue/audit.ts.
  `CREATE TABLE IF NOT EXISTS audit (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    event     TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash      TEXT NOT NULL
  )`,

  // 8 — claim: preserves original-owner evidence so funds can be returned.
  `CREATE TABLE IF NOT EXISTS claim (
    id              INTEGER PRIMARY KEY,
    hit_id          INTEGER REFERENCES hit(id),
    original_address TEXT,
    original_script  TEXT,
    balance         INTEGER,
    discovery_method TEXT,
    sweep_txid      TEXT,
    dest_address    TEXT,
    evidence_json   TEXT,
    created_at      INTEGER NOT NULL,
    resolved_at     INTEGER
  )`,

  // 9 — kv: small key/value for singletons (schema version handled separately).
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`
];

export function openDb(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(join(config.dataDir, 'satoshisearch.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  _db = db;
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migration (v INTEGER PRIMARY KEY, applied_at INTEGER)');
  const row = db.prepare('SELECT MAX(v) AS v FROM _migration').get() as { v: number | null };
  const current = row?.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.prepare('INSERT INTO _migration (v, applied_at) VALUES (?, ?)').run(i + 1, Math.floor(Date.now() / 1000));
  }
}

/** Convenience for scripts/tests that want a fresh handle without the singleton. */
export function openDbAt(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
