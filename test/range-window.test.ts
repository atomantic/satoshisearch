import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  puzzleBounds,
  resolvePuzzleWindow,
  parseHexScalar,
  parseShardToken,
  pctOfSize,
  formatHexScalar
} from '../src/lib/server/grinder/range-window.ts';
import { puzzleRangeSource } from '../src/lib/server/grinder/sources.ts';
import { makeSource } from '../src/lib/server/grinder/registry.ts';

test('puzzleBounds for n=71', () => {
  const b = puzzleBounds(71);
  assert.equal(b.lo, 1n << 70n);
  assert.equal(b.hi, 1n << 71n);
  assert.equal(b.size, 1n << 70n);
});

test('pctOfSize and startPct window', () => {
  const b = puzzleBounds(10);
  assert.equal(pctOfSize(b.size, 0), 0n);
  assert.equal(pctOfSize(b.size, 100), b.size);
  const half = pctOfSize(b.size, 50);
  assert.equal(half, b.size / 2n);

  const w = resolvePuzzleWindow(10, { startPct: 50 });
  assert.equal(w.start, b.lo + b.size / 2n);
  assert.equal(w.end, b.hi);
  assert.equal(w.size, b.size / 2n);
});

test('contiguous shards cover full range without overlap', () => {
  const b = puzzleBounds(12);
  const n = 4;
  const seen = new Set<string>();
  let total = 0n;
  for (let i = 0; i < n; i++) {
    const w = resolvePuzzleWindow(12, { shardIndex: i, shardCount: n });
    assert.ok(w.start >= b.lo && w.end <= b.hi);
    assert.ok(w.end > w.start);
    total += w.size;
    const key = `${w.start}-${w.end}`;
    assert.equal(seen.has(key), false);
    seen.add(key);
    // Adjacent slabs meet
    if (i > 0) {
      const prev = resolvePuzzleWindow(12, { shardIndex: i - 1, shardCount: n });
      assert.equal(prev.end, w.start);
    }
  }
  assert.equal(total, b.size);
});

test('shard after startPct only partitions remaining window', () => {
  const b = puzzleBounds(20);
  const w0 = resolvePuzzleWindow(20, { startPct: 50, shardIndex: 0, shardCount: 2 });
  const w1 = resolvePuzzleWindow(20, { startPct: 50, shardIndex: 1, shardCount: 2 });
  assert.equal(w0.start, b.lo + b.size / 2n);
  assert.equal(w1.end, b.hi);
  assert.equal(w0.end, w1.start);
  assert.equal(w0.size + w1.size, b.size / 2n);
});

test('parseHexScalar and parseShardToken', () => {
  assert.equal(parseHexScalar('0x10'), 16n);
  assert.equal(parseHexScalar('ff'), 255n);
  assert.equal(parseHexScalar('nope'), null);
  assert.deepEqual(parseShardToken('0/4'), { shardIndex: 0, shardCount: 4 });
  assert.deepEqual(parseShardToken('2 of 8'), { shardIndex: 2, shardCount: 8 });
  assert.equal(parseShardToken('x'), null);
});

test('puzzleRangeSource respects window; makeSource wires shard', () => {
  const w = resolvePuzzleWindow(8, { shardIndex: 1, shardCount: 2 });
  const src = puzzleRangeSource(8, { start: w.start, end: w.end, label: w.label });
  assert.ok(src.name.includes('s1of2'));
  assert.equal(src.size, w.size);

  const { range, done } = src.rangeBatch!(0n, 10);
  assert.equal(done, false);
  assert.ok(range);
  assert.equal(range!.start, w.start);
  assert.equal(range!.count, 10);

  const via = makeSource('puzzle-8', { shardIndex: 0, shardCount: 2 });
  assert.ok(via);
  assert.ok(via!.name.includes('s0of2'));
  assert.equal(via!.size, puzzleBounds(8).size / 2n);
});

test('hex start/end clamp into puzzle bounds', () => {
  const b = puzzleBounds(8);
  const w = resolvePuzzleWindow(8, {
    startHex: formatHexScalar(b.lo + 10n),
    endHex: formatHexScalar(b.lo + 20n)
  });
  assert.equal(w.start, b.lo + 10n);
  assert.equal(w.end, b.lo + 20n);
  assert.equal(w.size, 10n);
});
