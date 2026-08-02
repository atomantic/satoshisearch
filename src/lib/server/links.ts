/**
 * Explorer links. Like bitwatch, when a local mempool instance is configured we
 * point address/tx links at it for privacy, falling back to public mempool.space
 * only if the configured API is itself the public host.
 */
import { config } from './config';

function explorerBase(): string {
  // The mempool web UI is the API host without the trailing /api path. For a
  // local umbrel node this is the same origin as the REST API.
  return config.mempoolApiUrl.replace(/\/api$/, '');
}

export function addressLink(address: string): string {
  return `${explorerBase()}/address/${address}`;
}

export function txLink(txid: string): string {
  return `${explorerBase()}/tx/${txid}`;
}

export function isLocalNode(): boolean {
  return !/(^|\.)mempool\.space/.test(config.mempoolApiUrl);
}
