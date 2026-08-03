import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDbAt } from '../src/lib/server/db.ts';
import {
  loadMatchSet,
  matchSetCounts,
  describeMatchSetFilter,
  normalizeMatchDatasets,
  normalizePuzzleNs,
  type MatchSetFilter
} from '../src/lib/server/grinder/loadset.ts';

function seedTargets(dbPath: string) {
  const db = openDbAt(dbPath);

  const ins = db.prepare(
    `INSERT INTO target (dataset, address, script_hex, script_type, scripthash, hash160, pubkey, height, first_balance, last_balance, last_checked_at, status)
     VALUES (?, ?, NULL, 'p2pkh', ?, ?, ?, NULL, 0, 100, 1, 'funded')`
  );

  ins.run('coinbase', 'cb1', 'sh-cb1', 'aa'.repeat(20), '02' + '11'.repeat(32));
  ins.run('coinbase', 'cb2', 'sh-cb2', 'bb'.repeat(20), null);
  ins.run('dormant', 'dm1', 'sh-dm1', 'cc'.repeat(20), null);
  ins.run('richlist', 'rl1', 'sh-rl1', 'dd'.repeat(20), null);
  ins.run('richlist', 'rl2', 'sh-rl2', 'ee'.repeat(20), null);
  ins.run('puzzle', 'pz71', 'sh-pz71', 'f1'.repeat(20), null);
  ins.run('puzzle', 'pz72', 'sh-pz72', 'f2'.repeat(20), null);
  ins.run('puzzle', 'pz140', 'sh-pz140', 'f3'.repeat(20), '03' + '22'.repeat(32));

  const t71 = (db.prepare(`SELECT id FROM target WHERE address='pz71'`).get() as { id: number }).id;
  const t72 = (db.prepare(`SELECT id FROM target WHERE address='pz72'`).get() as { id: number }).id;
  const t140 = (db.prepare(`SELECT id FROM target WHERE address='pz140'`).get() as { id: number }).id;

  const pz = db.prepare(
    `INSERT INTO puzzle (n, target_id, range_lo, range_hi, status, pubkey_exposed, balance, solve_txid, solve_height, solved_at)
     VALUES (?, ?, '0', '1', 'sealed', 0, 1, NULL, NULL, NULL)`
  );
  pz.run(71, t71);
  pz.run(72, t72);
  pz.run(140, t140);
  return db;
}

test('normalizeMatchDatasets and puzzle Ns', () => {
  assert.deepEqual(normalizeMatchDatasets(['coinbase', 'COINBASE', 'nope', 'puzzle']), [
    'coinbase',
    'puzzle'
  ]);
  assert.deepEqual(normalizePuzzleNs(['71', 72, 0, 999, '140']), [71, 72, 140]);
});

test('loadMatchSet filters by dataset and puzzle N', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-match-'));
  try {
    const db = seedTargets(join(dir, 't.db'));

    const all: MatchSetFilter = {
      datasets: ['coinbase', 'dormant', 'puzzle', 'richlist'],
      puzzleNs: []
    };
    const full = loadMatchSet(all, db);
    // 2 coinbase h160 + 1 dormant + 2 richlist + 3 puzzle = 8 hash160; 2 pubkeys
    assert.equal(full.hash160s.size, 8);
    assert.equal(full.pubkeys.size, 2);
    assert.equal(full.size, 10);
    assert.equal(matchSetCounts(all, db).size, 10);

    const satoshi: MatchSetFilter = { datasets: ['coinbase', 'dormant'], puzzleNs: [] };
    const s = loadMatchSet(satoshi, db);
    assert.equal(s.hash160s.size, 3); // aa, bb, cc
    assert.equal(s.pubkeys.size, 1); // coinbase compressed
    assert.equal(s.size, 4);

    const puzzlesOnly: MatchSetFilter = { datasets: ['puzzle'], puzzleNs: [] };
    const p = loadMatchSet(puzzlesOnly, db);
    assert.equal(p.hash160s.size, 3);
    assert.equal(p.pubkeys.size, 1);

    const p71: MatchSetFilter = { datasets: ['puzzle'], puzzleNs: [71] };
    const one = loadMatchSet(p71, db);
    assert.equal(one.hash160s.size, 1);
    assert.ok(one.hash160s.has('f1'.repeat(20)));
    assert.equal(one.pubkeys.size, 0);

    const custom: MatchSetFilter = {
      datasets: ['coinbase', 'puzzle'],
      puzzleNs: [140]
    };
    const c = loadMatchSet(custom, db);
    // 2 coinbase hash160 + puzzle 140 hash160; coinbase pubkey + puzzle 140 pubkey
    assert.equal(c.hash160s.size, 3);
    assert.equal(c.pubkeys.size, 2);

    const empty: MatchSetFilter = { datasets: [], puzzleNs: [] };
    assert.equal(loadMatchSet(empty, db).size, 0);

    assert.equal(describeMatchSetFilter(custom), 'coinbase + puzzle #140');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveMatchSet presets resolve correctly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-match-eff-'));
  const prev = process.env.DATA_DIR;
  const prevProfile = process.env.MATCH_SET_PROFILE;
  const prevDs = process.env.MATCH_SET_DATASETS;
  const prevPz = process.env.MATCH_SET_PUZZLES;
  process.env.DATA_DIR = dir;
  delete process.env.MATCH_SET_PROFILE;
  delete process.env.MATCH_SET_DATASETS;
  delete process.env.MATCH_SET_PUZZLES;
  try {
    const { updateSettings, effectiveMatchSet } = await import('../src/lib/server/settings.ts');

    assert.equal(effectiveMatchSet().profile, 'all');
    assert.deepEqual(effectiveMatchSet().filter.datasets.sort(), [
      'coinbase',
      'dormant',
      'puzzle',
      'richlist'
    ]);

    updateSettings({ matchSet: { profile: 'satoshi', datasets: [], puzzleNs: [] } });
    assert.equal(effectiveMatchSet().profile, 'satoshi');
    assert.deepEqual(effectiveMatchSet().filter.datasets.sort(), ['coinbase', 'dormant']);

    updateSettings({ matchSet: { profile: 'puzzles', puzzleNs: [71, 140] } });
    let eff = effectiveMatchSet();
    assert.equal(eff.profile, 'puzzles');
    assert.deepEqual(eff.filter.datasets, ['puzzle']);
    assert.deepEqual(eff.filter.puzzleNs, [71, 140]);
    assert.match(eff.label, /71/);

    updateSettings({
      matchSet: {
        profile: 'custom',
        datasets: ['coinbase', 'puzzle'],
        puzzleNs: [140]
      }
    });
    eff = effectiveMatchSet();
    assert.equal(eff.profile, 'custom');
    assert.deepEqual(eff.filter.datasets.sort(), ['coinbase', 'puzzle']);
    assert.deepEqual(eff.filter.puzzleNs, [140]);

    process.env.MATCH_SET_PROFILE = 'richlist';
    assert.equal(effectiveMatchSet().profile, 'richlist');
    assert.deepEqual(effectiveMatchSet().filter.datasets, ['richlist']);
  } finally {
    process.env.DATA_DIR = prev;
    if (prevProfile === undefined) delete process.env.MATCH_SET_PROFILE;
    else process.env.MATCH_SET_PROFILE = prevProfile;
    if (prevDs === undefined) delete process.env.MATCH_SET_DATASETS;
    else process.env.MATCH_SET_DATASETS = prevDs;
    if (prevPz === undefined) delete process.env.MATCH_SET_PUZZLES;
    else process.env.MATCH_SET_PUZZLES = prevPz;
    rmSync(dir, { recursive: true, force: true });
  }
});
