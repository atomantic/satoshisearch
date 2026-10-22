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
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ss-mempool-pages-'));
process.env.DATA_DIR = dir;
process.env.__SS_DOTENV_LOADED = '1';
const { scriptTxsAll } = await import('../src/lib/server/mempool.ts');
const { updateSettings } = await import('../src/lib/server/settings.ts');
after(() => rmSync(dir, { recursive: true, force: true }));

// Any valid scriptPubKey works; the fake node ignores the hash.
const SCRIPT = '76a914' + 'ab'.repeat(20) + '88ac';

interface FakeTx {
  txid: string;
  vin: never[];
  vout: never[];
  status: { confirmed: boolean; block_height: number };
}

function history(n: number): FakeTx[] {
  // Newest first, like the real endpoints.
  return Array.from({ length: n }, (_, i) => ({
    txid: (n - i).toString(16).padStart(64, '0'),
    vin: [],
    vout: [],
    status: { confirmed: true, block_height: 100_000 + (n - i) }
  }));
}

type Flavour = 'mempool-backend' | 'esplora' | 'cursor-ignored';

interface FakeNode {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

/** A node serving `txs` under one of the real-world pagination behaviours. */
function fakeNode(flavour: Flavour, txs: FakeTx[], pageSize: number): Promise<FakeNode> {
  const requests: string[] = [];
  const pageAfter = (last: string | null): FakeTx[] => {
    const start = last === null ? 0 : txs.findIndex((t) => t.txid === last) + 1;
    return txs.slice(start, start + pageSize);
  };
  const server: Server = createServer((req, res) => {
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
      return notFound();
    }
    if (url.pathname.endsWith('/txs')) {
      const after = url.searchParams.get('after_txid');
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
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

async function withNode(
  flavour: Flavour,
  txs: FakeTx[],
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

test('mempool backend: walks every 10-tx page via after_txid, past the old 25-row stop', async () => {
  const txs = history(23);
  await withNode('mempool-backend', txs, 10, async (node) => {
    const got = await scriptTxsAll(SCRIPT);
    assert.deepEqual(txids(got), txids(txs), 'all 23 txs, newest first, none duplicated');
    assert.equal(node.requests.filter((r) => r.includes('after_txid=')).length, 3, 'three cursor pages (10, 10, 3)');
    assert.equal(node.requests.filter((r) => r.includes('/txs/chain/')).length, 0, 'after_txid worked first, so the esplora cursor is never tried');
  });
});

test('esplora: ignores after_txid, so the client falls back to /txs/chain/:last', async () => {
  const txs = history(60);
  await withNode('esplora', txs, 25, async (node) => {
    const got = await scriptTxsAll(SCRIPT);
    assert.deepEqual(txids(got), txids(txs), 'all 60 txs across 25/25/10 pages');
    assert.equal(node.requests.filter((r) => r.includes('/txs/chain/')).length, 3);
    assert.equal(node.requests.filter((r) => r.includes('after_txid=')).length, 1, 'echoed first page detected once');
  });
});

test('a node that ignores both cursors terminates after one echoed page', async () => {
  const txs = history(10);
  await withNode('cursor-ignored', txs, 10, async (node) => {
    const got = await scriptTxsAll(SCRIPT);
    assert.deepEqual(txids(got), txids(txs));
    assert.ok(node.requests.length <= 3, `bounded request count, got ${node.requests.length}`);
  });
});

test('the max cap stops pagination once enough txs are collected', async () => {
  const txs = history(100);
  await withNode('mempool-backend', txs, 10, async (node) => {
    const got = await scriptTxsAll(SCRIPT, 25);
    assert.equal(got.length, 30, 'stops at the first page boundary at or past the cap');
    assert.equal(node.requests.length, 3, `first page plus two cursor pages: ${node.requests.join(" ")}`);
  });
});

test('a short first page is not the end of the history', async () => {
  // The exact shape that hid puzzle 160: 15 txs, 10 per page, spend on page two.
  const txs = history(15);
  await withNode('mempool-backend', txs, 10, async () => {
    const got = await scriptTxsAll(SCRIPT);
    assert.equal(got.length, 15);
  });
});
