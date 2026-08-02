/**
 * Central runtime configuration, read once from the environment.
 *
 * In local dev these come from `.env` (see .env.example); under Umbrel they are
 * injected by docker-compose from exports.sh. Everything that can differ between
 * "my laptop against the dev node" and "installed on an Umbrel" lives here so no
 * other module has to know about the environment.
 */
/**
 * Env is read from `process.env` (not SvelteKit's `$env`) so this module works
 * identically in the web server AND in standalone scripts/tests. In dev we load
 * `.env` once here; in Umbrel the values arrive via docker-compose.
 */
import { readFileSync } from 'node:fs';

function loadDotenv(): void {
  if (process.env.__SS_DOTENV_LOADED) return;
  process.env.__SS_DOTENV_LOADED = '1';
  try {
    const raw = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue; // real env wins over .env file
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // No .env file (e.g. production/Umbrel) — rely entirely on real env.
  }
}
loadDotenv();
const env = process.env;

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** The 2015 funding transaction that created all 256 puzzle outputs. */
export const PUZZLE_FUNDING_TXID =
  '08389f34c98c606322740c0be6a7125d9860bb8d5cb182c02f98461e5fa6cd15';

export const config = {
  /** Esplora/mempool REST base, no trailing slash. */
  mempoolApiUrl: (env.MEMPOOL_API_URL || 'http://100.104.209.94:3006').replace(/\/+$/, ''),

  dataDir: env.DATA_DIR || './data',

  /** Concurrent in-flight requests to the node. ~8 measured as the sweet spot. */
  concurrency: int(env.MEMPOOL_CONCURRENCY, 8),

  /** How far to index early coinbase outputs (inclusive block height). */
  coinbaseMaxHeight: int(env.COINBASE_MAX_HEIGHT, 50_000),

  rescue: {
    destAddress: (env.RESCUE_DEST_ADDRESS || '').trim(),
    vaultKeyHex: (env.VAULT_KEY_HEX || '').trim(),
    /** Global broadcast kill switch. Defaults to safe (no broadcast). */
    dryRun: bool(env.SWEEP_DRY_RUN, true),
    dustSats: int(env.SWEEP_DUST_SATS, 10_000),
    /**
     * Buckets eligible for automatic sweep. Everything else is held + alerted.
     * Default: puzzles only — the one class explicitly meant to be swept.
     * Non-puzzle buckets here are only honored if `whitehatAttested` is true.
     */
    autoBuckets: new Set(
      (env.SWEEP_AUTO_BUCKETS ?? 'puzzle')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    ),
    /**
     * True only when the operator has attested, verbatim, to running an
     * authorized white-hat rescue. Required to auto-sweep any non-puzzle bucket.
     */
    whitehatAttested:
      (env.RESCUE_WHITEHAT_ATTESTATION || '').trim().toLowerCase() ===
      'i attest this is an authorized white-hat rescue and funds will be returned to their owners'
  }
} as const;

export type Bucket =
  | 'puzzle'
  | 'coinbase'
  | 'dormant'
  | 'richlist'
  | 'coldcard'
  | 'brainwallet'
  | 'constants'
  | 'lowentropy';

/**
 * Whether a hit in this bucket may be swept without per-hit human approval.
 *
 * Puzzle sweeping only needs the bucket enabled. Every other bucket may touch a
 * living person's funds, so it additionally requires the white-hat attestation —
 * enabling the bucket alone is not enough.
 */
export function mayAutoSweep(bucket: Bucket): boolean {
  if (!config.rescue.autoBuckets.has(bucket)) return false;
  if (bucket === 'puzzle') return true;
  return config.rescue.whitehatAttested;
}
