import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRichlistLine } from '../src/lib/server/indexer/richlist.ts';
import { formatNormalizedRow } from '../src/lib/server/indexer/richlist-format.ts';
import { openDbAt } from '../src/lib/server/db.ts';
import { decodeBitcoinAddress } from '../src/lib/server/script.ts';

const P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const P2WPKH_H160 = '751e76e8199196d454941c45d1b3a323f1433bd6';
const P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

test('parseRichlistLine accepts loyce-style address\\tbalance', () => {
  const { row } = parseRichlistLine(`${P2WPKH}\t150000000`);
  assert.ok(row);
  assert.equal(row?.scriptType, 'p2wpkh');
  assert.equal(row?.hash160, P2WPKH_H160);
  assert.equal(row?.balanceSats, 150000000);
  assert.equal(row?.scriptHex, `0014${P2WPKH_H160}`);
});

test('parseRichlistLine accepts normalized TSV', () => {
  const decoded = decodeBitcoinAddress(P2PKH)!;
  const line = formatNormalizedRow(P2PKH, 'p2pkh', decoded.hash160!, 200000000).trim();
  const { row } = parseRichlistLine(line);
  assert.ok(row);
  assert.equal(row?.scriptType, 'p2pkh');
  assert.equal(row?.hash160, decoded.hash160);
  assert.equal(row?.balanceSats, 200000000);
});

test('parseRichlistLine skips P2SH (multisig / nested ambiguous)', () => {
  // Valid mainnet P2SH (checksummed); not single-key grindable without redeem script.
  const { row, skipReason } = parseRichlistLine('3EExK1K1TF3v7zsFtQHt14XqexCwgmXM1y\t5000000000');
  assert.equal(row, null);
  assert.equal(skipReason, 'p2sh');
});

test('parseRichlistLine skips header and empty lines', () => {
  assert.equal(parseRichlistLine('address\tbalance').row, null);
  assert.equal(parseRichlistLine('').row, null);
  assert.equal(parseRichlistLine('# comment').row, null);
});

test('richlist_snapshot schema migrates and accepts rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-richlist-'));
  const db = openDbAt(join(dir, 't.db'));
  const snap = db
    .prepare(
      `INSERT INTO richlist_snapshot (source, created_at, tip_height, tip_hash, min_sats, script_policy, row_count, file_path, note)
       VALUES ('test', 1, NULL, NULL, 100000000, 'p2pkh,p2wpkh', 2, 'fixture', 'ok') RETURNING id`
    )
    .get() as { id: number };
  assert.ok(snap.id >= 1);
  rmSync(dir, { recursive: true, force: true });
});
