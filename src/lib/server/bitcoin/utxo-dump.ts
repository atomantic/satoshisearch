/**
 * Parse Bitcoin Core `dumptxoutset` snapshots (format v2, Core ≥28) and
 * aggregate single-key UTXOs into a balance-aware richlist.
 *
 * Serialization mirrors Core's CreateUTXOSnapshot + Coin/TxOutCompression:
 *   header: magic | u16 version | 4-byte network | 32-byte tip hash | u64 coins
 *   body:   for each tx: txid | CompactSize(n) | n × (CompactSize vout | Coin)
 *   Coin:   VarInt(height<<1|coinbase) | VarInt(compressed amount) | script
 *
 * Script special sizes 0–5 match CScriptCompressor (P2PKH/P2SH/P2PK).
 */
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { open as fsOpen } from 'node:fs/promises';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  classifyScript,
  p2pkhScript,
  p2wpkhScript,
  p2pkhAddress,
  p2wpkhAddress,
  hexToBytes,
  SINGLE_KEY_SCRIPT_TYPES,
  type ScriptType
} from '../script';
import {
  RICHLIST_TSV_HEADER,
  formatRichlistRow,
  formatNormalizedRow
} from '../indexer/richlist-format';

const SNAPSHOT_MAGIC = Buffer.from([0x75, 0x74, 0x78, 0x6f, 0xff]); // 'utxo\xff'
const MAINNET_MAGIC = Buffer.from([0xf9, 0xbe, 0xb4, 0xd9]);

export interface UtxoDumpHeader {
  version: number;
  networkMagic: Buffer;
  tipHashHex: string; // display order (reversed from internal LE)
  coinsCount: bigint;
}

export interface ParsedCoin {
  valueSats: number;
  scriptHex: string;
  scriptType: ScriptType;
  /** Full classification, carried through so callers need not re-classify. */
  cls: ReturnType<typeof classifyScript>;
  height: number;
  coinbase: boolean;
}

/** Streaming binary reader over a Buffer or growing file chunks. */
export class BinReader {
  private buf: Buffer;
  private off = 0;

  constructor(buf: Buffer = Buffer.alloc(0)) {
    this.buf = buf;
  }

  get offset(): number {
    return this.off;
  }
  get remaining(): number {
    return this.buf.length - this.off;
  }

  /** Ensure at least n bytes available (for sync parsers with full file). */
  need(n: number): void {
    if (this.remaining < n) throw new Error(`utxo dump truncated: need ${n}, have ${this.remaining}`);
  }

  u8(): number {
    this.need(1);
    return this.buf[this.off++];
  }

  u16le(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }

  u32le(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }

  u64le(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }

  /** Bitcoin CompactSize (vector lengths, vout index). */
  compactSize(): number {
    const ch = this.u8();
    if (ch < 253) return ch;
    if (ch === 253) return this.u16le();
    if (ch === 254) return this.u32le();
    const v = this.u64le();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('compactSize too large');
    return Number(v);
  }

  /** Bitcoin VARINT (MSB base-128) used by Coin / amount / script size. */
  varInt(): number {
    let n = 0n;
    for (;;) {
      const ch = BigInt(this.u8());
      n = (n << 7n) | (ch & 0x7fn);
      if (ch & 0x80n) {
        n += 1n;
      } else {
        break;
      }
    }
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('varInt too large');
    return Number(n);
  }
}

/** Decompress Core's CompressAmount encoding. */
export function decompressAmount(x: number): number {
  if (x === 0) return 0;
  x -= 1;
  let e = x % 10;
  x = Math.floor(x / 10);
  let n: number;
  if (e < 9) {
    const d = (x % 9) + 1;
    x = Math.floor(x / 9);
    n = x * 10 + d;
  } else {
    n = x + 1;
  }
  while (e > 0) {
    n *= 10;
    e--;
  }
  return n;
}

/** Compress amount (for tests / synthetic dumps). */
export function compressAmount(n: number): number {
  if (n === 0) return 0;
  let e = 0;
  while (n % 10 === 0 && e < 9) {
    n = Math.floor(n / 10);
    e++;
  }
  if (e < 9) {
    const d = n % 10;
    n = Math.floor(n / 10);
    return 1 + (n * 9 + d - 1) * 10 + e;
  }
  return 1 + (n - 1) * 10 + 9;
}

/** Encode Bitcoin VARINT into a Buffer. */
export function encodeVarInt(n: number): Buffer {
  const bytes: number[] = [];
  let x = BigInt(n);
  bytes.push(Number(x & 0x7fn));
  while (x > 0x7fn) {
    x = (x >> 7n) - 1n;
    bytes.push(Number((x & 0x7fn) | 0x80n));
  }
  bytes.reverse();
  return Buffer.from(bytes);
}

export function encodeCompactSize(n: number): Buffer {
  if (n < 253) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 253;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = 254;
    b.writeUInt32LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 255;
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
}

function reverseHex(buf: Buffer): string {
  return Buffer.from(buf).reverse().toString('hex');
}

/**
 * Decompress a script from Core's ScriptCompression stream.
 * Returns raw scriptPubKey bytes.
 */
export function decompressScript(r: BinReader): Buffer {
  const size = r.varInt();
  if (size === 0) {
    // P2PKH
    const h = r.bytes(20);
    return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), h, Buffer.from([0x88, 0xac])]);
  }
  if (size === 1) {
    // P2SH
    const h = r.bytes(20);
    return Buffer.concat([Buffer.from([0xa9, 0x14]), h, Buffer.from([0x87])]);
  }
  if (size === 2 || size === 3) {
    // P2PK compressed
    const x = r.bytes(32);
    const pub = Buffer.concat([Buffer.from([size]), x]);
    return Buffer.concat([Buffer.from([0x21]), pub, Buffer.from([0xac])]);
  }
  if (size === 4 || size === 5) {
    // P2PK: stored as compressed (02/03 + x), expand to uncompressed for script
    const x = r.bytes(32);
    const prefix = size - 2; // 2 or 3
    const compressed = Buffer.concat([Buffer.from([prefix]), x]);
    try {
      const point = secp256k1.ProjectivePoint.fromHex(compressed.toString('hex'));
      const uncomp = Buffer.from(point.toRawBytes(false));
      return Buffer.concat([Buffer.from([0x41]), uncomp, Buffer.from([0xac])]);
    } catch {
      // Fall back to compressed form if decompress fails
      const pub = Buffer.concat([Buffer.from([prefix]), x]);
      return Buffer.concat([Buffer.from([0x21]), pub, Buffer.from([0xac])]);
    }
  }
  const actual = size - 6;
  if (actual < 0 || actual > 10_000) throw new Error(`invalid script size code ${size}`);
  return Buffer.from(r.bytes(actual));
}

export function parseCoin(r: BinReader): ParsedCoin {
  const code = r.varInt();
  const height = code >>> 1;
  const coinbase = (code & 1) === 1;
  const valueSats = decompressAmount(r.varInt());
  const script = decompressScript(r);
  const scriptHex = script.toString('hex');
  const cls = classifyScript(scriptHex);
  return {
    valueSats,
    scriptHex,
    scriptType: cls.type,
    cls,
    height,
    coinbase
  };
}

export function parseHeader(r: BinReader): UtxoDumpHeader {
  const magic = r.bytes(5);
  if (!magic.equals(SNAPSHOT_MAGIC)) {
    throw new Error(
      'not a Core ≥28 utxo snapshot (missing utxo\\xff magic). Legacy dumps are unsupported — use Bitcoin Core 28+ dumptxoutset.'
    );
  }
  const version = r.u16le();
  if (version !== 2) throw new Error(`unsupported snapshot version ${version}`);
  const networkMagic = Buffer.from(r.bytes(4));
  const tipInternal = r.bytes(32);
  const coinsCount = r.u64le();
  return {
    version,
    networkMagic,
    tipHashHex: reverseHex(tipInternal),
    coinsCount
  };
}

export interface AggregateOptions {
  minSats: number;
  /** Keep these script types (default single-key). */
  keepTypes?: Set<ScriptType>;
  onProgress?: (coinsRead: number, keptScripts: number) => void;
}

/** One aggregated script: total balance plus everything needed to write a row. */
export interface AggregatedRow {
  balance: number;
  scriptType: ScriptType;
  address: string;
  scriptHex: string;
  matchKind: 'hash160' | 'pubkey';
  matchHex: string;
}

export interface AggregateResult {
  header: UtxoDumpHeader;
  /** matchKey (`${matchKind}:${matchHex}`) → aggregated row */
  rows: Map<string, AggregatedRow>;
  coinsRead: number;
  skippedByType: Record<string, number>;
  /** Script types actually kept, so the written header cannot claim otherwise. */
  scriptPolicy: string;
}

/**
 * Parse an entire dump file from a Buffer (tests / small files).
 * For multi‑GB dumps use `aggregateUtxoDumpFile`.
 */
export function aggregateUtxoDumpBuffer(buf: Buffer, opts: AggregateOptions): AggregateResult {
  const r = new BinReader(buf);
  const header = parseHeader(r);
  const keep = opts.keepTypes ?? SINGLE_KEY_SCRIPT_TYPES;
  const rows = new Map<string, AggregatedRow>();
  const skippedByType: Record<string, number> = {};
  let coinsRead = 0;
  const target = header.coinsCount;

  while (coinsRead < target) {
    // Need at least a txid
    if (r.remaining < 32) break;
    r.bytes(32); // txid — not needed, we aggregate by script
    const nCoins = r.compactSize();
    for (let i = 0; i < nCoins; i++) {
      r.compactSize(); // vout
      const coin = parseCoin(r);
      coinsRead++;
      if (coinsRead % 500_000 === 0) opts.onProgress?.(coinsRead, rows.size);

      if (!keep.has(coin.scriptType)) {
        skippedByType[coin.scriptType] = (skippedByType[coin.scriptType] ?? 0) + 1;
        continue;
      }

      const cls = coin.cls;
      let matchKind: 'hash160' | 'pubkey';
      let matchHex: string;

      if (coin.scriptType === 'p2pk' && cls.pubkey) {
        matchKind = 'pubkey';
        matchHex = cls.pubkey.toLowerCase();
      } else if (cls.hash160) {
        matchKind = 'hash160';
        matchHex = cls.hash160.toLowerCase();
      } else {
        skippedByType['no-match-key'] = (skippedByType['no-match-key'] ?? 0) + 1;
        continue;
      }

      const key = `${matchKind}:${matchHex}`;
      const prev = rows.get(key);
      if (prev) {
        // Most coins land here — deriving the address/script again would be
        // base58/bech32 work thrown straight away.
        prev.balance += coin.valueSats;
        continue;
      }

      let address: string;
      let scriptHex = coin.scriptHex;
      if (matchKind === 'pubkey') {
        address = cls.address ?? '';
      } else if (coin.scriptType === 'p2wpkh') {
        address = p2wpkhAddress(hexToBytes(matchHex));
        scriptHex = p2wpkhScript(matchHex);
      } else {
        address = p2pkhAddress(hexToBytes(matchHex));
        scriptHex = p2pkhScript(matchHex);
      }

      rows.set(key, {
        balance: coin.valueSats,
        scriptType: coin.scriptType,
        address,
        scriptHex,
        matchKind,
        matchHex
      });
    }
  }

  // Apply min balance filter in place
  for (const [k, v] of rows) {
    if (v.balance < opts.minSats) rows.delete(k);
  }

  opts.onProgress?.(coinsRead, rows.size);
  return { header, rows, coinsRead, skippedByType, scriptPolicy: [...keep].join(',') };
}

/**
 * Parse a dump file from disk by loading it into a single Buffer.
 *
 * NOTE: this is not streaming. A mainnet snapshot exceeds the 3.5 GB ceiling
 * below, so the documented "preferred" Core path currently fails on its real
 * input; wiring a chunked reader (fixed-size reads compacting the consumed
 * head, not Buffer.concat) is the outstanding work here.
 */
export async function aggregateUtxoDumpFile(
  path: string,
  opts: AggregateOptions
): Promise<AggregateResult> {
  const fh = await fsOpen(path, 'r');
  try {
    const stat = await fh.stat();
    // Prefer single-buffer when < 3.5 GB to keep code simple (Node buffer limit ~4GB issues vary).
    if (stat.size < 3_500_000_000) {
      const buf = Buffer.allocUnsafe(stat.size);
      await fh.read(buf, 0, stat.size, 0);
      return aggregateUtxoDumpBuffer(buf, opts);
    }
    throw new Error(
      `UTXO dump is ${(stat.size / 1e9).toFixed(1)} GB — too large for in-process full load. ` +
        `Filter on the host with a higher min balance after a streaming tool, or run parse on a machine with more headroom.`
    );
  } finally {
    await fh.close();
  }
}

export interface WriteRichlistOptions {
  outPath: string;
  minSats: number;
  source?: string;
  tipHeight?: number | null;
}

/** Write aggregated rows as gzipped normalized TSV (same as loyce fetch). */
export async function writeAggregatedRichlist(
  agg: AggregateResult,
  opts: WriteRichlistOptions
): Promise<{ kept: number }> {
  const gzip = createGzip();
  const out = createWriteStream(opts.outPath);
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', () => resolve());
    out.on('error', reject);
    gzip.on('error', reject);
  });
  gzip.pipe(out);

  gzip.write(RICHLIST_TSV_HEADER);
  gzip.write(`# source=${opts.source ?? 'core-utxo'}\n`);
  gzip.write(`# tip_hash=${agg.header.tipHashHex}\n`);
  if (opts.tipHeight != null) gzip.write(`# tip_height=${opts.tipHeight}\n`);
  gzip.write(`# coins_in_dump=${agg.header.coinsCount}\n`);
  gzip.write(`# min_sats=${opts.minSats}\n`);
  gzip.write(`# script_policy=${agg.scriptPolicy}\n`);
  gzip.write(`# network_magic=${agg.header.networkMagic.toString('hex')}\n`);

  let kept = 0;
  // Sort by balance desc for readable diffs
  const sorted = [...agg.rows.values()].sort((a, b) => b.balance - a.balance);
  for (const row of sorted) {
    if (row.matchKind === 'hash160' && (row.scriptType === 'p2pkh' || row.scriptType === 'p2wpkh')) {
      gzip.write(formatNormalizedRow(row.address, row.scriptType, row.matchHex, row.balance));
      kept++;
    } else if (row.matchKind === 'pubkey') {
      // Empty address is fine for P2PK — parseRichlistLine synthesizes one.
      gzip.write(
        formatRichlistRow({
          address: row.address,
          scriptType: row.scriptType,
          matchKind: 'pubkey',
          matchHex: row.matchHex,
          balanceSats: row.balance,
          scriptHex: row.scriptHex
        })
      );
      kept++;
    }
  }
  gzip.end();
  await done;
  return { kept };
}

/** Build a minimal synthetic v2 dump for unit tests. */
export function buildSyntheticDumpV2(
  coins: Array<{ script: Buffer; valueSats: number; height?: number; coinbase?: boolean; vout?: number }>
): Buffer {
  // Group all under one fake txid
  const txid = Buffer.alloc(32, 0x11);
  const tip = Buffer.alloc(32, 0x22);
  const parts: Buffer[] = [];
  parts.push(SNAPSHOT_MAGIC);
  const ver = Buffer.alloc(2);
  ver.writeUInt16LE(2, 0);
  parts.push(ver);
  parts.push(MAINNET_MAGIC);
  parts.push(tip);
  const count = Buffer.alloc(8);
  count.writeBigUInt64LE(BigInt(coins.length), 0);
  parts.push(count);

  parts.push(txid);
  parts.push(encodeCompactSize(coins.length));
  for (const c of coins) {
    parts.push(encodeCompactSize(c.vout ?? 0));
    const height = c.height ?? 100;
    const code = (height << 1) | (c.coinbase ? 1 : 0);
    parts.push(encodeVarInt(code));
    parts.push(encodeVarInt(compressAmount(c.valueSats)));
    // Raw script: size code = script.length + 6
    parts.push(encodeVarInt(c.script.length + 6));
    parts.push(c.script);
  }
  return Buffer.concat(parts);
}
