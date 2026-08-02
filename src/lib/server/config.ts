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
import { SINGLE_KEY_SCRIPT_POLICY } from './script';

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

/**
 * The exact sentence an operator must attest, verbatim, to enable auto-sweep
 * of any non-puzzle bucket. Shared with the Settings UI so both env var and
 * form validation require the identical text.
 */
export const WHITEHAT_ATTESTATION_TEXT =
  'i attest this is an authorized white-hat rescue and funds will be returned to their owners';

export const config = {
  /** Esplora/mempool REST base, no trailing slash. */
  mempoolApiUrl: (env.MEMPOOL_API_URL || 'http://100.104.209.94:3006').replace(/\/+$/, ''),

  dataDir: env.DATA_DIR || './data',

  /** Concurrent in-flight requests to the node. ~8 measured as the sweet spot. */
  concurrency: int(env.MEMPOOL_CONCURRENCY, 8),

  /** How far to index early coinbase outputs (inclusive block height). */
  coinbaseMaxHeight: int(env.COINBASE_MAX_HEIGHT, 50_000),

  /**
   * Richlist / match-set balance snapshot settings.
   * Default min 1 BTC keeps the set near historical scale (~1M all-types on loyce).
   */
  richlist: {
    minSats: int(env.RICHLIST_MIN_SATS, 100_000_000),
    scriptPolicy: (env.RICHLIST_SCRIPT_POLICY || SINGLE_KEY_SCRIPT_POLICY).trim(),
    loyceUrl:
      (env.RICHLIST_LOYCE_URL ||
        'http://addresses.loyce.club/blockchair_bitcoin_addresses_and_balance_LATEST.tsv.gz').trim()
  },

  /** Optional Bitcoin Core RPC (phase 2 UTXO dump). */
  bitcoinRpc: {
    url: (env.BITCOIN_RPC_URL || '').replace(/\/+$/, ''),
    user: (env.BITCOIN_RPC_USER || '').trim(),
    password: (env.BITCOIN_RPC_PASSWORD || '').trim(),
    cookie: (env.BITCOIN_RPC_COOKIE || '').trim()
  },

  /** Optional Fulcrum Electrum endpoint for hit-time balance verify. */
  fulcrum: {
    host: (env.FULCRUM_HOST || '').trim(),
    port: int(env.FULCRUM_PORT, 50002)
  },

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
      (env.RESCUE_WHITEHAT_ATTESTATION || '').trim().toLowerCase() === WHITEHAT_ATTESTATION_TEXT
  }
} as const;

/**
 * Every dataset bucket a target can belong to, in UI display order.
 * Single source of truth — `Bucket` is derived from it so the type and the
 * runtime list can never drift apart.
 */
export const BUCKETS = [
  'puzzle',
  'coinbase',
  'dormant',
  'richlist',
  'coldcard',
  'brainwallet',
  'constants',
  'lowentropy'
] as const;

export type Bucket = (typeof BUCKETS)[number];
