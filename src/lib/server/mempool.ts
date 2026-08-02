/**
 * Esplora/mempool.space REST client for the local node.
 *
 * Everything the app knows about the chain comes through here. Two design points
 * learned from probing the dev node:
 *   - Balance for Satoshi-era P2PK must be read by script hash, not address.
 *   - `/api/block/:hash/txid/:i` 404s on this build; use `/api/block/:hash/txids`.
 *
 * A tiny bounded-concurrency pool keeps us at the measured sweet spot (~8) so a
 * full 22K sweep finishes in ~1.3 min without hammering the node.
 */
import { config } from './config';
import { scriptHash } from './script';

export interface AddressStats {
  funded_txo_count: number;
  funded_txo_sum: number;
  spent_txo_count: number;
  spent_txo_sum: number;
  tx_count: number;
}

export interface ScriptHashStatus {
  scripthash: string;
  chain_stats: AddressStats;
  mempool_stats: AddressStats;
}

export interface TxVout {
  scriptpubkey: string;
  scriptpubkey_asm: string;
  scriptpubkey_type: string;
  scriptpubkey_address?: string;
  value: number;
}

export interface TxVin {
  is_coinbase: boolean;
  txid: string;
  vout: number;
  prevout: TxVout | null;
  scriptsig?: string;
  scriptsig_asm?: string;
  witness?: string[];
}

export interface Tx {
  txid: string;
  version: number;
  locktime: number;
  vin: TxVin[];
  vout: TxVout[];
  status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
}

class HttpError extends Error {
  constructor(public status: number, public url: string, body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

async function req(path: string, init?: RequestInit, retries = 4): Promise<Response> {
  const url = `${config.mempoolApiUrl}${path}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      // Retry only on transient upstream failures.
      if (res.status >= 500 || res.status === 429) {
        lastErr = new HttpError(res.status, url, await res.text().catch(() => ''));
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
    }
    // Exponential backoff with a small fixed base; node is local so keep it tight.
    await new Promise((r) => setTimeout(r, 150 * 2 ** attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getJson<T>(path: string): Promise<T> {
  const res = await req(path);
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, path, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response for ${path}: ${text.slice(0, 120)}`);
  }
}

async function getText(path: string): Promise<string> {
  const res = await req(path);
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, path, text);
  return text.trim();
}

/** Confirmed spendable balance (sats) for a raw scriptPubKey. */
export async function scriptBalance(scriptPubKeyHex: string): Promise<number> {
  const s = await getJson<ScriptHashStatus>(`/api/scripthash/${scriptHash(scriptPubKeyHex)}`);
  return s.chain_stats.funded_txo_sum - s.chain_stats.spent_txo_sum;
}

export async function scriptStatus(scriptPubKeyHex: string): Promise<ScriptHashStatus> {
  return getJson<ScriptHashStatus>(`/api/scripthash/${scriptHash(scriptPubKeyHex)}`);
}

export async function addressStatus(address: string): Promise<ScriptHashStatus> {
  return getJson<ScriptHashStatus>(`/api/address/${address}`);
}

export async function getTx(txid: string): Promise<Tx> {
  return getJson<Tx>(`/api/tx/${txid}`);
}

/** Raw transaction hex — needed as `nonWitnessUtxo` when signing legacy inputs. */
export async function getTxHex(txid: string): Promise<string> {
  return getText(`/api/tx/${txid}/hex`);
}

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean };
}

export async function scriptUtxos(scriptPubKeyHex: string): Promise<Utxo[]> {
  return getJson<Utxo[]>(`/api/scripthash/${scriptHash(scriptPubKeyHex)}/utxo`);
}

/** Most recent txs touching a scriptPubKey (confirmed + mempool, up to ~50). */
export async function scriptTxs(scriptPubKeyHex: string): Promise<Tx[]> {
  return getJson<Tx[]>(`/api/scripthash/${scriptHash(scriptPubKeyHex)}/txs`);
}

/**
 * All confirmed txs touching a scriptPubKey, paginated via /txs/chain/:last.
 * Esplora returns 25 confirmed per page. Capped at `max` to bound pathological
 * addresses (genesis has 64K txs); puzzle addresses are well under the cap.
 */
export async function scriptTxsAll(scriptPubKeyHex: string, max = 200): Promise<Tx[]> {
  const sh = scriptHash(scriptPubKeyHex);
  const all: Tx[] = [];
  // First page: /txs (mempool + recent confirmed). Then paginate confirmed via
  // /txs/chain/:lastTxid. This node 404s on a bare /txs/chain (no last txid).
  let page = await getJson<Tx[]>(`/api/scripthash/${sh}/txs`);
  while (page.length && all.length < max) {
    all.push(...page);
    if (page.length < 25) break;
    page = await getJson<Tx[]>(`/api/scripthash/${sh}/txs/chain/${page[page.length - 1].txid}`);
  }
  return all;
}

/** Sum of confirmed UTXO values (sats) — authoritative balance, node-mode-agnostic. */
export async function scriptUtxoBalance(scriptPubKeyHex: string): Promise<number> {
  const utxos = await getJson<Array<{ value: number; status: { confirmed: boolean } }>>(
    `/api/scripthash/${scriptHash(scriptPubKeyHex)}/utxo`
  );
  return utxos.reduce((a, u) => a + (u.status?.confirmed ? u.value : 0), 0);
}

export async function tipHeight(): Promise<number> {
  return Number(await getText('/api/blocks/tip/height'));
}

export async function blockHashAtHeight(height: number): Promise<string> {
  return getText(`/api/block-height/${height}`);
}

/** Coinbase txid for a block = first entry of /txids. */
export async function coinbaseTxid(blockHash: string): Promise<string> {
  const ids = await getJson<string[]>(`/api/block/${blockHash}/txids`);
  return ids[0];
}

export interface FeeEstimates {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

export async function recommendedFees(): Promise<FeeEstimates> {
  return getJson<FeeEstimates>('/api/v1/fees/recommended');
}

/** Broadcast a raw transaction hex; returns the txid. Guarded by callers. */
export async function broadcastTx(rawHex: string): Promise<string> {
  const res = await req('/api/tx', { method: 'POST', body: rawHex });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, '/api/tx', text);
  return text.trim();
}

/**
 * Run `worker` over `items` with bounded concurrency, preserving input order in
 * the results. Used by every sweep/index loop. Errors from a single item reject
 * the whole batch — callers that want per-item tolerance should catch inside.
 */
export async function mapPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = config.concurrency
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return results;
}
