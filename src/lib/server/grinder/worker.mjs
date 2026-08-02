/**
 * Grinder worker (plain ESM). Handles:
 *   init           — load match-set
 *   batch          — packed privkeys + origins
 *   range          — sequential scalars [start, start+count)
 *   coldcard-batch — RNG-state expand (NOT a sequential key range):
 *                      S → Yasmarang entropy → BIP39 → BIP32 → common paths → match
 *                    Derived keys are full 256-bit scalars scattered in keyspace.
 *
 * Coldcard expand runs here so the main thread stays free for the UI/API.
 */
import { parentPort } from 'node:worker_threads';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

let HASH160 = new Set();
let PUBKEYS = new Set();

function toHex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
function h160(pub) {
  return ripemd160(sha256(pub));
}

/**
 * Match a private key against the loaded sets. Returns hit fields, null for no
 * match, or undefined for an invalid scalar.
 */
function tryMatch(priv, origin) {
  try {
    const pub = secp256k1.ProjectivePoint.fromPrivateKey(priv);
    const comp = pub.toRawBytes(true);
    const uncomp = pub.toRawBytes(false);

    if (PUBKEYS.size) {
      const cHex = toHex(comp);
      if (PUBKEYS.has(cHex)) {
        return { kind: 'pubkey', matched: cHex, privHex: toHex(priv), origin };
      }
      const uHex = toHex(uncomp);
      if (PUBKEYS.has(uHex)) {
        return { kind: 'pubkey', matched: uHex, privHex: toHex(priv), origin };
      }
    }
    const cH = toHex(h160(comp));
    if (HASH160.has(cH)) {
      return { kind: 'hash160-compressed', matched: cH, privHex: toHex(priv), origin };
    }
    const uH = toHex(h160(uncomp));
    if (HASH160.has(uH)) {
      return { kind: 'hash160-uncompressed', matched: uH, privHex: toHex(priv), origin };
    }
    return null;
  } catch {
    return undefined; // invalid scalar
  }
}

function beInc(priv) {
  for (let i = 31; i >= 0; i--) {
    if (++priv[i] !== 0) break;
  }
}

function privToBigHex(priv) {
  return toHex(priv).replace(/^0+/, '') || '0';
}

/** MicroPython Yasmarang — same as yasmarang.ts */
class Yasmarang {
  constructor(seed) {
    this.pad = seed.pad >>> 0;
    this.n = seed.n >>> 0;
    this.d = seed.d >>> 0;
    this.dat = 0;
  }
  next() {
    this.pad = (this.pad + this.dat + Math.imul(this.d, this.n)) >>> 0;
    this.pad = (((this.pad << 3) >>> 0) + (this.pad >>> 29)) >>> 0;
    this.n = (this.pad | 2) >>> 0;
    this.d = (this.d ^ ((((this.pad << 31) >>> 0) + (this.pad >>> 1)) >>> 0)) >>> 0;
    this.dat = (this.dat ^ (this.pad & 0xff) ^ ((this.d >>> 8) & 0xff) ^ 1) & 0xff;
    return (this.pad ^ ((this.d << 5) >>> 0) ^ (this.pad >>> 18) ^ ((this.dat << 1) >>> 0)) >>> 0;
  }
  bytes(n) {
    const out = new Uint8Array(n);
    let i = 0;
    while (i < n) {
      const w = this.next();
      out[i++] = w & 0xff;
      if (i < n) out[i++] = (w >>> 8) & 0xff;
      if (i < n) out[i++] = (w >>> 16) & 0xff;
      if (i < n) out[i++] = (w >>> 24) & 0xff;
    }
    return out;
  }
}

const LIBNGU_INIT = { pad: 0x0a8ce26f, n: 69, d: 233 };

function xorEntropy(seed, n) {
  const mp = new Yasmarang(seed);
  const lg = new Yasmarang(LIBNGU_INIT);
  const out = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const w = (mp.next() ^ lg.next()) >>> 0;
    out[i++] = w & 0xff;
    if (i < n) out[i++] = (w >>> 8) & 0xff;
    if (i < n) out[i++] = (w >>> 16) & 0xff;
    if (i < n) out[i++] = (w >>> 24) & 0xff;
  }
  return out;
}

function sha256d(data) {
  const h1 = createHash('sha256').update(data).digest();
  return createHash('sha256').update(h1).digest();
}

/** BIP39 PBKDF2 via OpenSSL (native) — matches bip39-seed.ts */
function mnemonicToSeedFast(mnemonic, passphrase = '') {
  const password = mnemonic.normalize('NFKD');
  const salt = (`mnemonic${passphrase}`).normalize('NFKD');
  return new Uint8Array(pbkdf2Sync(password, salt, 2048, 64, 'sha512'));
}

function keysForSeed(cfg, seed) {
  let entropy =
    cfg.entropyStream === 'libngu-xor'
      ? xorEntropy(seed, cfg.entropyBytes)
      : new Yasmarang(seed).bytes(cfg.entropyBytes);
  if (cfg.sha256dEntropy) {
    entropy = new Uint8Array(sha256d(entropy).subarray(0, cfg.entropyBytes));
  }
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  const bip39seed = mnemonicToSeedFast(mnemonic);
  const root = HDKey.fromMasterSeed(bip39seed);
  const origin = `coldcard:pad=${seed.pad.toString(16)},n=${seed.n.toString(16)},d=${seed.d.toString(16)}`;
  const out = [];
  for (const tpl of cfg.pathTemplates) {
    for (let i = 0; i < cfg.addressGap; i++) {
      const child = root.derive(`${tpl}/${i}`);
      if (child.privateKey) out.push({ priv: child.privateKey, origin: `${origin} ${tpl}/${i}` });
    }
  }
  return out;
}

parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    HASH160 = new Set(msg.hash160s);
    PUBKEYS = new Set(msg.pubkeys);
    parentPort.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'batch') {
    const privs = new Uint8Array(msg.privs);
    const count = privs.length / 32;
    const matches = [];
    let checked = 0;
    for (let i = 0; i < count; i++) {
      const priv = privs.subarray(i * 32, i * 32 + 32);
      const hit = tryMatch(priv, msg.origins[i]);
      if (hit === undefined) continue;
      checked++;
      if (hit) matches.push({ index: i, ...hit });
    }
    parentPort.postMessage({ type: 'result', id: msg.id, checked, matches });
    return;
  }

  if (msg.type === 'range') {
    const start = new Uint8Array(msg.start);
    const count = msg.count >>> 0;
    const originPrefix = msg.originPrefix || 'range';
    const originDecimal = !!msg.originDecimal;
    const matches = [];
    let checked = 0;
    const priv = new Uint8Array(start);
    for (let i = 0; i < count; i++) {
      if (i > 0) beInc(priv);
      // Origin is only ever read for a hit, so keep the hex/BigInt formatting
      // out of the per-key loop — that is the whole point of range mode.
      const hit = tryMatch(priv, null);
      if (hit === undefined) continue;
      checked++;
      if (hit) {
        hit.origin = originDecimal
          ? `${originPrefix}:${BigInt('0x' + toHex(priv)).toString()}`
          : `${originPrefix}:0x${privToBigHex(priv)}`;
        matches.push({ index: i, ...hit });
      }
    }
    parentPort.postMessage({ type: 'result', id: msg.id, checked, matches });
    return;
  }

  if (msg.type === 'coldcard-batch') {
    const cfg = msg.cfg;
    const seeds = msg.seeds;
    const matches = [];
    let checked = 0;
    let keyIndex = 0;
    for (const seed of seeds) {
      const keys = keysForSeed(cfg, seed);
      for (const k of keys) {
        const hit = tryMatch(k.priv, k.origin);
        const index = keyIndex++;
        if (hit === undefined) continue;
        checked++;
        if (hit) matches.push({ index, ...hit });
      }
    }
    parentPort.postMessage({ type: 'result', id: msg.id, checked, matches });
  }
});
