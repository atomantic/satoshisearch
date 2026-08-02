/**
 * Integration tests against a live mempool/electrs node. These are the tests
 * that lock in the P2PK correctness fix and puzzle classification — the whole
 * reason satoshisearch exists — so they hit the real node rather than mocks.
 *
 * Skipped automatically when the node is unreachable, so `npm test` stays green
 * offline. Point MEMPOOL_API_URL at your node to run them.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { scriptBalance, getTx, tipHeight } from '../src/lib/server/mempool.ts';
import { classifyPuzzle, derivePuzzleTargets } from '../src/lib/server/indexer/puzzles.ts';
import { p2pkScript } from '../src/lib/server/script.ts';

let nodeUp = false;
before(async () => {
  try {
    await tipHeight();
    nodeUp = true;
  } catch {
    nodeUp = false;
  }
});

test('P2PK balance is read by script hash, not address (the core fix)', async (t) => {
  if (!nodeUp) return t.skip('node unreachable');
  // Block-9 coinbase P2PK to Satoshi — 18 BTC net, invisible to an address query.
  const blk9Pubkey =
    '0411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3';
  const bal = await scriptBalance(p2pkScript(blk9Pubkey));
  assert.equal(bal, 1_800_000_000, 'block-9 P2PK should hold 18 BTC by script hash');
});

test('block-1000 coinbase reports 50 BTC by script hash', async (t) => {
  if (!nodeUp) return t.skip('node unreachable');
  // The regression: address lookups return ~0.0001 BTC here; script hash sees 50.
  const tx = await getTx('fe28050b93faea61fa88c4c630f0e1f0a1c24d0082dd0e10d369e13212128f33');
  const bal = await scriptBalance(tx.vout[0].scriptpubkey);
  assert.equal(bal, 5_000_000_000);
});

test('puzzle 71/72 are sealed+funded; 160 is exposed+funded', async (t) => {
  if (!nodeUp) return t.skip('node unreachable');
  const targets = await derivePuzzleTargets();
  const p71 = await classifyPuzzle(targets[70].scriptHex);
  assert.equal(p71.status, 'sealed');
  assert.ok(p71.balance > 0);
  assert.equal(p71.pubkeyExposed, false);

  const p160 = await classifyPuzzle(targets[159].scriptHex);
  assert.equal(p160.status, 'exposed');
  assert.ok(p160.balance > 0);
  assert.ok(p160.pubkey, 'exposed puzzle should reveal a pubkey');
});
