/**
 * Minimal Bitcoin Core JSON-RPC client.
 *
 * Auth: cookie file (`user:pass` on one line) or explicit user/password.
 * Credentials resolve from ./data/settings.json (UI) first, then env.
 * Used for dumptxoutset / getblockchaininfo — not for per-address grinding.
 */
import { readFileSync } from 'node:fs';
import { effectiveBitcoinRpc } from '../settings';

export class BitcoinRpcError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown
  ) {
    super(message);
    this.name = 'BitcoinRpcError';
  }
}

export interface RpcAuth {
  url: string;
  user: string;
  password: string;
}

/** Resolve RPC endpoint + credentials from settings / env / explicit overrides. */
export function resolveRpcAuth(overrides?: Partial<RpcAuth> & { cookie?: string }): RpcAuth {
  const eff = effectiveBitcoinRpc();
  const url = (overrides?.url || eff.url || 'http://127.0.0.1:8332').replace(/\/+$/, '');
  let user = overrides?.user ?? eff.user;
  let password = overrides?.password ?? eff.password;
  const cookiePath = overrides?.cookie || eff.cookie;

  if ((!user || !password) && cookiePath) {
    const raw = readFileSync(cookiePath, 'utf8').trim();
    const colon = raw.indexOf(':');
    if (colon < 0) throw new Error(`invalid bitcoin cookie file: ${cookiePath}`);
    user = raw.slice(0, colon);
    password = raw.slice(colon + 1);
  }

  if (!user || !password) {
    throw new Error(
      'Bitcoin RPC credentials missing. Set them in Settings (saved to data/settings.json) or BITCOIN_RPC_USER/PASSWORD / BITCOIN_RPC_COOKIE.'
    );
  }
  if (!url) {
    throw new Error('Bitcoin RPC URL missing. Set it in Settings or BITCOIN_RPC_URL.');
  }
  return { url, user, password };
}

export function isRpcConfigured(): boolean {
  const eff = effectiveBitcoinRpc();
  return !!(eff.url && ((eff.user && eff.password) || eff.cookie));
}

let _id = 0;

export async function bitcoinRpc<T = unknown>(
  method: string,
  params: unknown[] = [],
  auth?: RpcAuth
): Promise<T> {
  const a = auth ?? resolveRpcAuth();
  const body = JSON.stringify({ jsonrpc: '1.0', id: String(++_id), method, params });
  const token = Buffer.from(`${a.user}:${a.password}`).toString('base64');
  const res = await fetch(a.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${token}`
    },
    body
  });
  const text = await res.text();
  let parsed: { result?: T; error?: { code: number; message: string; data?: unknown } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BitcoinRpcError(`Non-JSON RPC response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (parsed.error) {
    throw new BitcoinRpcError(parsed.error.message, parsed.error.code, parsed.error.data);
  }
  if (!res.ok) {
    throw new BitcoinRpcError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return parsed.result as T;
}

export interface BlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  verificationprogress: number;
  initialblockdownload: boolean;
  pruned: boolean;
}

export async function getBlockchainInfo(auth?: RpcAuth): Promise<BlockchainInfo> {
  return bitcoinRpc<BlockchainInfo>('getblockchaininfo', [], auth);
}

export interface DumpTxOutSetResult {
  coins_written: number;
  base_hash: string;
  base_height: number;
  path: string;
  txoutset_hash: string;
  nchaintx?: number;
}

/**
 * Ask Core to write a UTXO snapshot on the **node's** filesystem.
 * Path is relative to datadir unless absolute on that host.
 */
export async function dumpTxOutSet(path: string, auth?: RpcAuth): Promise<DumpTxOutSetResult> {
  return bitcoinRpc<DumpTxOutSetResult>('dumptxoutset', [path], auth);
}
