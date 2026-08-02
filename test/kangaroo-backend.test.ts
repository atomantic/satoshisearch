/**
 * Kangaroo multi-backend helpers (JLP parse, templates, hex pad).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  padHexScalar,
  normalizePrivHex,
  parseJlpProgress,
  parseJlpPriv,
  splitCommand
} from '../src/lib/server/grinder/kangaroo-backends.ts';

test('padHexScalar accepts odd-length puzzle ranges', () => {
  // 2^139 as stored by the indexer (35 hex digits)
  const lo = '80000000000000000000000000000000000';
  assert.equal(lo.length % 2, 1);
  const p = padHexScalar(lo);
  assert.equal(p.length, 64);
  assert.ok(p.endsWith(lo), 'original digits preserved at the low end');
  assert.equal(BigInt('0x' + p), BigInt('0x' + lo));
});

test('normalizePrivHex left-pads short JLP privs', () => {
  assert.equal(
    normalizePrivHex('378ABDEC51BC5D'),
    '00000000000000000000000000000000000000000000000000378abdec51bc5d'
  );
});

test('parseJlpProgress reads MKey/s and Count', () => {
  const line =
    '[22.67 MKey/s][GPU 13.04 MKey/s][Count 2^29.06][Dead 0][28s][89.1MB]';
  const p = parseJlpProgress(line);
  assert.ok(p);
  assert.ok(Math.abs(p!.opsPerSec - 22.67e6) < 1e3);
  assert.ok(p!.ops > 0);
  assert.equal(p!.elapsedMs, 28000);
});

test('parseJlpProgress reads multi-hour time and MK/s total', () => {
  const line =
    '[7828.45 MK/s][GPU 7828.45 MK/s][Count 2^43.22][Dead 2][24:56 (Avg 20:24)][4.8/6.9GB]';
  const p = parseJlpProgress(line);
  assert.ok(p);
  assert.ok(p!.opsPerSec > 7e9);
  assert.equal(p!.elapsedMs, (24 * 60 + 56) * 1000);
});

test('parseJlpPriv extracts and pads key', () => {
  const line = '       Priv: 0x3447F65ABC9F46F736A95F87B044829C8A0129D56782D635CD612C0F05F3DA03';
  const p = parseJlpPriv(line);
  assert.equal(p, '3447f65abc9f46f736a95f87b044829c8a0129d56782d635cd612c0f05f3da03');
});

test('splitCommand handles quoted tokens', () => {
  assert.deepEqual(splitCommand('foo "bar baz" -d 18'), ['foo', 'bar baz', '-d', '18']);
});
