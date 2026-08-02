import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compressAmount,
  decompressAmount,
  encodeVarInt,
  BinReader,
  buildSyntheticDumpV2,
  aggregateUtxoDumpBuffer,
  parseHeader
} from '../src/lib/server/bitcoin/utxo-dump.ts';
import { p2pkhScript, p2wpkhScript, hexToBytes } from '../src/lib/server/script.ts';

test('amount compress/decompress round-trips', () => {
  for (const n of [0, 1, 546, 100_000_000, 50 * 1e8, 123456789, 20_999_999_9769_0000]) {
    assert.equal(decompressAmount(compressAmount(n)), n, `n=${n}`);
  }
});

test('VARINT round-trips via reader', () => {
  for (const n of [0, 1, 127, 128, 255, 300, 16384, 1_000_000]) {
    const enc = encodeVarInt(n);
    const r = new BinReader(enc);
    assert.equal(r.varInt(), n);
  }
});

test('synthetic dump aggregates P2PKH + P2WPKH above min', () => {
  const h160a = '62e907b15cbf27d5425399ebf6f0fb50ebb88f18';
  const h160b = '751e76e8199196d454941c45d1b3a323f1433bd6';
  const dump = buildSyntheticDumpV2([
    { script: Buffer.from(hexToBytes(p2pkhScript(h160a))), valueSats: 250_000_000, vout: 0 },
    { script: Buffer.from(hexToBytes(p2wpkhScript(h160b))), valueSats: 150_000_000, vout: 1 },
    // dust — filtered by minSats
    { script: Buffer.from(hexToBytes(p2pkhScript('11'.repeat(20)))), valueSats: 1000, vout: 2 }
  ]);

  const header = parseHeader(new BinReader(dump));
  assert.equal(header.version, 2);
  assert.equal(header.coinsCount, 3n);

  const agg = aggregateUtxoDumpBuffer(dump, { minSats: 100_000_000 });
  assert.equal(agg.coinsRead, 3);
  assert.equal(agg.rows.size, 2);

  const a = [...agg.rows.values()].find((r) => r.matchHex === h160a);
  const b = [...agg.rows.values()].find((r) => r.matchHex === h160b);
  assert.ok(a);
  assert.ok(b);
  assert.equal(a?.balance, 250_000_000);
  assert.equal(a?.scriptType, 'p2pkh');
  assert.equal(b?.balance, 150_000_000);
  assert.equal(b?.scriptType, 'p2wpkh');
});

test('aggregates multiple UTXOs to same script', () => {
  const h160 = 'aa'.repeat(20);
  const script = Buffer.from(hexToBytes(p2pkhScript(h160)));
  const dump = buildSyntheticDumpV2([
    { script, valueSats: 80_000_000, vout: 0 },
    { script, valueSats: 30_000_000, vout: 1 }
  ]);
  const agg = aggregateUtxoDumpBuffer(dump, { minSats: 100_000_000 });
  assert.equal(agg.rows.size, 1);
  const row = [...agg.rows.values()][0];
  assert.equal(row.balance, 110_000_000);
});

test('skips P2SH scripts', () => {
  // OP_HASH160 PUSH20 <h> OP_EQUAL
  const p2sh = Buffer.concat([
    Buffer.from([0xa9, 0x14]),
    Buffer.alloc(20, 0xab),
    Buffer.from([0x87])
  ]);
  const dump = buildSyntheticDumpV2([{ script: p2sh, valueSats: 500_000_000, vout: 0 }]);
  const agg = aggregateUtxoDumpBuffer(dump, { minSats: 1 });
  assert.equal(agg.rows.size, 0);
  assert.ok((agg.skippedByType['p2sh'] ?? 0) >= 1);
});
