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

/**
 * Coarse human duration. Kangaroo ETAs range from seconds to far past the age
 * of the universe, so anything beyond a year falls back to a magnitude-suffixed
 * year count rather than an unreadable pile of digits.
 */
export function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  const days = seconds / 86_400;
  if (days < 365) return `${Math.floor(days)}d ${Math.round((days % 1) * 24)}h`;
  const years = days / 365.25;
  if (years < 1000) return `${years < 10 ? years.toFixed(1) : Math.round(years)}y`;
  return `${bigCount(Math.round(years))}y`;
}

export function timeAgo(unixSec: number | null): string {
  if (!unixSec) return 'never';
  const s = Math.floor(Date.now() / 1000) - unixSec;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
