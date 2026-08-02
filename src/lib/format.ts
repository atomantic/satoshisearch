/** Shared display formatters (safe on both server and client). */

export function btc(sats: number): string {
  return (sats / 1e8).toLocaleString('en-US', { minimumFractionDigits: 8, maximumFractionDigits: 8 });
}

export function btcShort(sats: number): string {
  const v = sats / 1e8;
  if (v === 0) return '0';
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return v.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

export function shortAddr(addr: string, head = 8, tail = 6): string {
  if (!addr || addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** Big-integer keyspace size for an N-bit range, as a readable power-of-two. */
export function bitsLabel(bits: number): string {
  return `2^${bits}`;
}

/** Format a count of keys with a magnitude suffix. */
export function bigCount(n: number): string {
  if (n < 1000) return String(n);
  const units = ['', 'K', 'M', 'B', 'T', 'P', 'E'];
  let u = 0;
  let v = n;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)}${units[u]}`;
}

export function timeAgo(unixSec: number | null): string {
  if (!unixSec) return 'never';
  const s = Math.floor(Date.now() / 1000) - unixSec;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
