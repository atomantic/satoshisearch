/**
 * Grinder worker (plain ESM, no TypeScript) so it loads identically under tsx in
 * dev and node in the adapter-node build — no worker bundling required. It only
 * depends on the @noble runtime packages, which resolve from node_modules in
 * both environments.
 *
 * Protocol:
 *   main → worker  { type: 'init', hash160s: string[], pubkeys: string[] }
 *   main → worker  { type: 'batch', id, privs: ArrayBuffer(n*32), origins: string[] }
 *   worker → main  { type: 'ready' }
 *   worker → main  { type: 'result', id, checked, matches: [{index, kind, matched, privHex, origin}] }
 *
 * The hot loop mirrors matchset.ts: derive compressed + uncompressed pubkeys,
 * check raw pubkey (P2PK) and hash160 of both encodings. Base58 is never touched.
 */
import { parentPort } from 'node:worker_threads';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';

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

parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    HASH160 = new Set(msg.hash160s);
    PUBKEYS = new Set(msg.pubkeys);
    parentPort.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type !== 'batch') return;

  const privs = new Uint8Array(msg.privs);
  const count = privs.length / 32;
  const matches = [];
  let checked = 0;

  for (let i = 0; i < count; i++) {
    const priv = privs.subarray(i * 32, i * 32 + 32);
    let pub;
    try {
      pub = secp256k1.ProjectivePoint.fromPrivateKey(priv);
    } catch {
      continue; // invalid scalar
    }
    checked++;
    const comp = pub.toRawBytes(true);
    const uncomp = pub.toRawBytes(false);

    if (PUBKEYS.size) {
      const cHex = toHex(comp);
      if (PUBKEYS.has(cHex)) {
        matches.push({ index: i, kind: 'pubkey', matched: cHex, privHex: toHex(priv), origin: msg.origins[i] });
        continue;
      }
      const uHex = toHex(uncomp);
      if (PUBKEYS.has(uHex)) {
        matches.push({ index: i, kind: 'pubkey', matched: uHex, privHex: toHex(priv), origin: msg.origins[i] });
        continue;
      }
    }
    const cH = toHex(h160(comp));
    if (HASH160.has(cH)) {
      matches.push({ index: i, kind: 'hash160-compressed', matched: cH, privHex: toHex(priv), origin: msg.origins[i] });
      continue;
    }
    const uH = toHex(h160(uncomp));
    if (HASH160.has(uH)) {
      matches.push({ index: i, kind: 'hash160-uncompressed', matched: uH, privHex: toHex(priv), origin: msg.origins[i] });
    }
  }

  parentPort.postMessage({ type: 'result', id: msg.id, checked, matches });
});
