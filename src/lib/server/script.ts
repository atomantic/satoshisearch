/**
 * Bitcoin script & address primitives.
 *
 * The reason this module exists as its own thing: the original satoshifinder
 * stored *derived P2PKH addresses* for coins that actually live in **P2PK**
 * outputs. electrs does not index P2PK under a derived address, so an
 * address-based balance query silently under-reports Satoshi-era coins by
 * ~99.99%. The fix is to always query by **script hash** = sha256(scriptPubKey),
 * and to keep the real scriptPubKey around. Every balance lookup in the app
 * flows through `scriptHash()` here.
 */
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { base58check, bech32, bech32m } from '@scure/base';

const b58c = base58check(sha256);

export type ScriptType = 'p2pk' | 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'unknown';

/**
 * Single-key script types the grinder can usefully match / the richlist keeps.
 * The one owner of this policy — config defaults, the Settings UI and the UTXO
 * aggregator all derive from it rather than restating the list.
 */
export const SINGLE_KEY_SCRIPT_TYPE_LIST = ['p2pk', 'p2pkh', 'p2wpkh'] as const;
export const SINGLE_KEY_SCRIPT_TYPES = new Set<ScriptType>(SINGLE_KEY_SCRIPT_TYPE_LIST);
export const SINGLE_KEY_SCRIPT_POLICY = SINGLE_KEY_SCRIPT_TYPE_LIST.join(',');

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * Esplora `/api/scripthash/{h}` path parameter: the hex-encoded sha256 of the
 * raw scriptPubKey in **forward** byte order. Verified end-to-end against the
 * node (returns the correct 18 BTC for block-9 P2PK).
 *
 * Gotcha, do not "fix": the JSON *response* echoes a `scripthash` field in the
 * reversed (Electrum-protocol) order, which looks like it disagrees with what we
 * send. It doesn't — the URL wants forward, the echo is reversed. Asserting our
 * output against that echoed field is the wrong test.
 */
export function scriptHash(scriptPubKeyHex: string): string {
  return bytesToHex(sha256(hexToBytes(scriptPubKeyHex)));
}

/** Encode a 20-byte hash160 as a version-0 (P2PKH) base58check address. */
export function p2pkhAddress(h160: Uint8Array, version = 0x00): string {
  const payload = new Uint8Array(1 + h160.length);
  payload[0] = version;
  payload.set(h160, 1);
  return b58c.encode(payload);
}

/** Decode a base58check P2PKH/P2SH address back to {version, hash160}. */
export function decodeBase58Address(addr: string): { version: number; hash: Uint8Array } {
  const payload = b58c.decode(addr);
  return { version: payload[0], hash: payload.slice(1) };
}

/** Encode a 20-byte witness program as a mainnet P2WPKH bech32 address. */
export function p2wpkhAddress(h160: Uint8Array, hrp = 'bc'): string {
  const words = bech32.toWords(h160);
  return bech32.encode(hrp, [0, ...words]);
}

/** Encode a 32-byte x-only key as a mainnet P2TR bech32m address. */
export function p2trAddress(xonly: Uint8Array, hrp = 'bc'): string {
  const words = bech32m.toWords(xonly);
  return bech32m.encode(hrp, [1, ...words]);
}

/**
 * Decode a mainnet Bitcoin address into a script type + payload useful for the
 * grinder match-set. Returns null for garbage / wrong network / unsupported forms.
 *
 * Single-key keep list: p2pkh, p2wpkh. P2SH / P2WSH / P2TR are returned so
 * callers can count and drop them (multisig / multi-party / phase-2).
 */
export function decodeBitcoinAddress(addr: string): {
  type: ScriptType;
  hash160: string | null;
  xonly: string | null;
  address: string;
} | null {
  const a = addr.trim();
  if (!a) return null;

  // Bech32 / bech32m (bc1…)
  if (a.toLowerCase().startsWith('bc1')) {
    try {
      // Try bech32 first (v0), then bech32m (v1+).
      let decoded: { prefix: string; words: number[] } | null = null;
      let enc: 'bech32' | 'bech32m' = 'bech32';
      try {
        decoded = bech32.decode(a as `${string}1${string}`);
        enc = 'bech32';
      } catch {
        decoded = bech32m.decode(a as `${string}1${string}`);
        enc = 'bech32m';
      }
      if (decoded.prefix.toLowerCase() !== 'bc') return null;
      const ver = decoded.words[0];
      const prog = (enc === 'bech32' ? bech32 : bech32m).fromWords(decoded.words.slice(1));
      if (ver === 0 && prog.length === 20) {
        return { type: 'p2wpkh', hash160: bytesToHex(prog), xonly: null, address: a };
      }
      if (ver === 0 && prog.length === 32) {
        return { type: 'p2wsh', hash160: null, xonly: null, address: a };
      }
      if (ver === 1 && prog.length === 32) {
        return { type: 'p2tr', hash160: null, xonly: bytesToHex(prog), address: a };
      }
      return { type: 'unknown', hash160: null, xonly: null, address: a };
    } catch {
      return null;
    }
  }

  // Base58 legacy
  try {
    const { version, hash } = decodeBase58Address(a);
    if (hash.length !== 20) return null;
    if (version === 0x00) return { type: 'p2pkh', hash160: bytesToHex(hash), xonly: null, address: a };
    if (version === 0x05) return { type: 'p2sh', hash160: bytesToHex(hash), xonly: null, address: a };
    return null;
  } catch {
    return null;
  }
}

/**
 * Classify a scriptPubKey and, where meaningful, derive a display address and
 * the hash160/pubkey it commits to. For P2PK there is no address form — the
 * output commits to a bare pubkey — so `address` is derived P2PKH purely for
 * human display, while balance MUST still be looked up by script hash.
 */
export function classifyScript(scriptHex: string): {
  type: ScriptType;
  address: string | null;
  hash160: string | null;
  pubkey: string | null;
} {
  const bytes = hexToBytes(scriptHex);

  // P2PK: <PUSH(33|65)> <pubkey> OP_CHECKSIG(0xac)
  if (
    (bytes.length === 35 && bytes[0] === 0x21 && bytes[34] === 0xac) ||
    (bytes.length === 67 && bytes[0] === 0x41 && bytes[66] === 0xac)
  ) {
    const pub = bytes.slice(1, bytes.length - 1);
    const h = hash160(pub);
    return { type: 'p2pk', address: p2pkhAddress(h), hash160: bytesToHex(h), pubkey: bytesToHex(pub) };
  }

  // Bare multisig: OP_m … OP_n OP_CHECKMULTISIG — never single-key grindable.
  if (bytes.length >= 3 && bytes[bytes.length - 1] === 0xae) {
    return { type: 'unknown', address: null, hash160: null, pubkey: null };
  }

  // P2PKH: OP_DUP OP_HASH160 PUSH20 <h160> OP_EQUALVERIFY OP_CHECKSIG
  if (
    bytes.length === 25 &&
    bytes[0] === 0x76 &&
    bytes[1] === 0xa9 &&
    bytes[2] === 0x14 &&
    bytes[23] === 0x88 &&
    bytes[24] === 0xac
  ) {
    const h = bytes.slice(3, 23);
    return { type: 'p2pkh', address: p2pkhAddress(h), hash160: bytesToHex(h), pubkey: null };
  }

  // P2SH: OP_HASH160 PUSH20 <h160> OP_EQUAL
  if (bytes.length === 23 && bytes[0] === 0xa9 && bytes[1] === 0x14 && bytes[22] === 0x87) {
    const h = bytes.slice(2, 22);
    return { type: 'p2sh', address: p2pkhAddress(h, 0x05), hash160: bytesToHex(h), pubkey: null };
  }

  // Witness programs: OP_0/OP_1 <push len> <program>
  if (bytes.length >= 4 && bytes[1] === bytes.length - 2) {
    if (bytes[0] === 0x00 && bytes.length === 22) {
      const h = bytes.slice(2);
      return { type: 'p2wpkh', address: p2wpkhAddress(h), hash160: bytesToHex(h), pubkey: null };
    }
    if (bytes[0] === 0x00 && bytes.length === 34) return { type: 'p2wsh', address: null, hash160: null, pubkey: null };
    if (bytes[0] === 0x51 && bytes.length === 34) {
      const x = bytes.slice(2);
      return { type: 'p2tr', address: p2trAddress(x), hash160: null, pubkey: null };
    }
  }

  return { type: 'unknown', address: null, hash160: null, pubkey: null };
}

/** Build the P2PK scriptPubKey hex for a raw (33- or 65-byte) pubkey. */
export function p2pkScript(pubkeyHex: string): string {
  const pub = hexToBytes(pubkeyHex);
  const push = pub.length.toString(16).padStart(2, '0');
  return `${push}${pubkeyHex.toLowerCase()}ac`;
}

/** Build the P2PKH scriptPubKey hex for a 20-byte hash160. */
export function p2pkhScript(h160Hex: string): string {
  return `76a914${h160Hex.toLowerCase()}88ac`;
}

/** Build the P2WPKH scriptPubKey hex for a 20-byte hash160: OP_0 PUSH20 <h160>. */
export function p2wpkhScript(h160Hex: string): string {
  return `0014${h160Hex.toLowerCase()}`;
}

/**
 * Resolve a spendable scriptPubKey for a target row. Prefers stored script_hex;
 * otherwise reconstructs from hash160 + script_type (defaults to p2pkh).
 */
export function scriptForTarget(target: {
  script_hex?: string | null;
  hash160?: string | null;
  script_type?: string | null;
}): string | null {
  if (target.script_hex) return target.script_hex;
  if (!target.hash160) return null;
  if (target.script_type === 'p2wpkh') return p2wpkhScript(target.hash160);
  return p2pkhScript(target.hash160);
}
