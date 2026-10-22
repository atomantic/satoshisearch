/**
 * `scriptTxsAll` must walk every page of a script's history on both node
 * flavours we run against, without knowing the page size up front:
 *
 *   - the mempool backend (electrum mode) pages 10 at a time via `?after_txid=`
 *     and 404s the esplora cursor;
 *   - esplora / electrs REST pages 25 at a time via `/txs/chain/:last` and
 *     ignores unknown query params (echoing the first page back).
 *
 * The old loop stopped on "fewer than 25 in a page", which on the mempool
 * backend meant it never fetched page two — and so never saw the spend that
 * exposes puzzle 160's pubkey (issue #3). These run against a fake node so they
 * hold offline; the live expectation lives in node-integration.test.ts.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tx } from '../src/lib/server/mempool.ts';

const dir = mkdtempSync(join(tmpdir(), 'ss-mempool-pages-'));
process.env.DATA_DIR = dir;
process.env.__SS_DOTENV_LOADED = '1';
const { scriptTxsAll } = await import('../src/lib/server/mempool.ts');
const { updateSettings } = await import('../src/lib/server/settings.ts');
after(() => rmSync(dir, { recursive: true, force: true }));

// Any valid scriptPubKey works; the fake node ignores the hash.
const SCRIPT = '76a914' + 'ab'.repeat(20) + '88ac';

/** `n` confirmed txs with empty inputs/outputs, newest first like the real endpoints. */
function history(n: number): Tx[] {
  return Array.from({ length: n }, (_, i) => ({
    txid: (n - i).toString(16).padStart(64, '0'),
    version: 1,
    locktime: 0,
    vin: [],
    vout: [],
    status: { confirmed: true, block_height: 100_000 + (n - i) }
  }));
}

type Flavour = 'mempool-backend' | 'esplora' | 'cursor-ignored' | 'both-404';

interface FakeNode {
  url: string;
  requests: string[];
  /** Swap the backend behind the same URL mid-test. */
  setFlavour: (f: Flavour) => void;
  close: () => Promise<void>;
}

/** A node serving `txs` under one of the real-world pagination behaviours. */
function fakeNode(initial: Flavour, txs: Tx[], pageSize: number): Promise<FakeNode> {
  let flavour = initial;
  const requests: string[] = [];
  const pageAfter = (last: string | null): Tx[] => {
    const start = last === null ? 0 : txs.findIndex((t) => t.txid === last) + 1;
    return txs.slice(start, start + pageSize);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    requests.push(url.pathname + url.search);
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const notFound = () => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<pre>Cannot GET ' + url.pathname + '</pre>');
    };
    const chain = url.pathname.match(/\/txs\/chain\/([0-9a-f]+)$/);
    if (chain) {
      if (flavour === 'esplora') return json(pageAfter(chain[1]));
      if (flavour === 'cursor-ignored') return json(pageAfter(null));
      return notFound(); // mempool-backend and both-404
    }
    if (url.pathname.endsWith('/txs')) {
      const after = url.searchParams.get('after_txid');
      if (after !== null && flavour === 'both-404') return notFound();
      if (flavour === 'mempool-backend') return json(pageAfter(after));
      // esplora and the broken node ignore the query param entirely.
      return json(pageAfter(null));
    }
    return notFound();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        setFlavour: (f) => {
          flavour = f;
        },
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

async function withNode(
  flavour: Flavour,
  txs: Tx[],
  pageSize: number,
  fn: (node: FakeNode) => Promise<void>
): Promise<void> {
  const node = await fakeNode(flavour, txs, pageSize);
  // Settings win over env, and a new URL makes the client re-detect the cursor.
  updateSettings({ runtime: { mempoolApiUrl: node.url } });
  try {
    await fn(node);
  } finally {
    await node.close();
  }
}

const txids = (txs: { txid: string }[]) => txs.map((t) => t.txid);
const count = (node: FakeNode, needle: string) => node.requests.filter((r) => r.includes(needle)).length;

test('mempool backend: walks every 10-tx page via after_txid, past the old 25-row stop', async () => {
  // 23 txs at 10 per page: the first page is "short" by the old 25-row rule yet
  // two more pages follow — the exact shape that hid puzzle 160's reveal spend.
  const txs = history(23);
  await withNode('mempool-backend', txs, 10, async (node) => {
    const got = await scriptTxsAll(SCRIPT);
    assert.deepEqual(txids(got), txids(txs), 'all 23 txs, newest first, none duplicated');
    assert.equal(count(node, '/txs/chain/'), 1, 'esplora cursor probed once (404), then dropped');
    assert.equal(count(node, 'after_txid='), 3, 'three cursor pages (10, 10, 3)');
  });
});

test('esplora: /txs/chain/:last works first time, so after_txid is never probed', async () => {
  const txs = history(60);
  await withNode('esplora', txs, 25, async (node) => {
    const got = await scriptTxsAll(SCRIPT);
    assert.deepEqual(txids(got), txids(txs), 'all 60 txs across 25/25/10 pages');
    assert.equal(count(node, '/txs/chain/'), 3);
    assert.equal(count(node, 'after_txid='), 0);
  });
});

test('a node that ignores both cursors terminates after one echoed page each', async () => {
  const txs = history(10);
  await withNode('cursor-ignored', txs, 10, async (node) => {
    const got = await scriptTxsAll(SCRIPT);
    assert.deepEqual(txids(got), txids(txs));
    assert.equal(node.requests.length, 3, 'first page, then one echo per cursor style');
  });
});

test('the max cap stops pagination once enough txs are collected', async () => {
  const txs = history(100);
  await withNode('mempool-backend', txs, 10, async (node) => {
    const got = await scriptTxsAll(SCRIPT, { max: 25 });
    assert.equal(got.length, 30, 'stops at the first page boundary at or past the cap');
    assert.equal(node.requests.length, 4, `first page, one 404 probe, two cursor pages: ${node.requests.join(' ')}`);
  });
});

test("the node's tx_count skips the trailing empty-page request", async () => {
  const txs = history(7);
  await withNode('mempool-backend', txs, 10, async (node) => {
    const got = await scriptTxsAll(SCRIPT, { expected: 7 });
    assert.equal(got.length, 7);
    assert.equal(node.requests.length, 1, 'the first page already held every tx');
  });
});

test('a tx_count above the first page still walks the remaining pages', async () => {
  const txs = history(15);
  await withNode('mempool-backend', txs, 10, async (node) => {
    const got = await scriptTxsAll(SCRIPT, { expected: 15 });
    assert.equal(got.length, 15, 'page two is fetched when page one falls short of the count');
    assert.equal(count(node, 'after_txid='), 1);
  });
});

test('a memoized cursor that stops working is re-probed, not treated as the end', async () => {
  const txs = history(30);
  await withNode('mempool-backend', txs, 10, async (node) => {
    assert.equal((await scriptTxsAll(SCRIPT)).length, 30, 'warm-up memoizes after_txid for this URL');
    node.setFlavour('esplora');
    node.requests.length = 0;
    const got = await scriptTxsAll(SCRIPT);
    assert.equal(got.length, 30, 'esplora behind the same URL still yields the full history');
    assert.ok(count(node, 'after_txid=') >= 1, 'the stale memo was tried first');
    assert.ok(count(node, '/txs/chain/') >= 1, 'then the other cursor took over');
  });
});

test('a node that 404s every cursor is an error, not the end of the history', async () => {
  const txs = history(12);
  await withNode('both-404', txs, 10, async () => {
    await assert.rejects(scriptTxsAll(SCRIPT), /No tx cursor style accepted/);
  });
});
