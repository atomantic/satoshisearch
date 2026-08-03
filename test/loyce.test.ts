import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchLoyceRichlist } from '../src/lib/server/indexer/loyce.ts';

const P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/** A balance-descending dump: `rich` rows above the cutoff, then a long tail below it. */
function dumpGz(rich: number, tail: number): Buffer {
  const lines: string[] = ['address\tbalance'];
  for (let i = 0; i < rich; i++) {
    lines.push(`${i % 2 ? P2PKH : P2WPKH}\t${500_000_000 - i}`);
  }
  for (let i = 0; i < tail; i++) {
    lines.push(`${P2PKH}\t${1000 - (i % 1000)}`);
  }
  return gzipSync(Buffer.from(lines.join('\n') + '\n'));
}

/** Serves `bodies[n]` for the nth request; a body may be a truncated gzip. */
function serve(bodies: Buffer[]): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    const body = bodies[Math.min(hits, bodies.length - 1)];
    hits++;
    res.writeHead(200, { 'content-type': 'application/gzip' });
    // No content-length: a short body then a clean end is exactly how the real
    // host hangs up — the client sees EOF mid-gzip-member, not a socket error.
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/dump.tsv.gz`,
        hits: () => hits,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

function withTmp(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loyce-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  'stops at the balance cutoff and publishes a readable gz',
  withTmp(async (dir) => {
    const srv = await serve([dumpGz(200, 5000)]);
    const out = join(dir, 'balances.tsv.gz');
    try {
      const res = await fetchLoyceRichlist({ url: srv.url, outPath: out, minSats: 100_000_000 });
      assert.equal(res.hitCutoff, true);
      assert.equal(res.kept, 200);
      assert.equal(res.attempts, 1);

      // The whole point: the published file must gunzip cleanly.
      const text = gunzipSync(readFileSync(out)).toString();
      assert.equal(text.split('\n').filter((l) => l && !l.startsWith('#')).length, 200);
      assert.equal(existsSync(`${out}.partial`), false);
    } finally {
      await srv.close();
    }
  })
);

test(
  'a truncated download fails loudly and leaves the previous snapshot in place',
  withTmp(async (dir) => {
    const full = dumpGz(80_000, 0);
    const srv = await serve([full.subarray(0, Math.floor(full.length * 0.5))]);
    const out = join(dir, 'balances.tsv.gz');
    const previous = gzipSync(Buffer.from('# previous good snapshot\n'));
    writeFileSync(out, previous);

    try {
      // minSats below every row, so the cutoff is never reached and the source
      // dies mid-stream — the exact Z_BUF_ERROR case from the runner logs.
      await assert.rejects(
        fetchLoyceRichlist({ url: srv.url, outPath: out, minSats: 1, attempts: 1 }),
        /truncated/
      );
    } finally {
      await srv.close();
    }

    assert.deepEqual(readFileSync(out), previous, 'good snapshot was overwritten');
    assert.equal(existsSync(`${out}.partial`), false, 'partial file left behind');
  })
);

test(
  'retries a truncated download and publishes the good one',
  withTmp(async (dir) => {
    // Cutoff sits past the truncation point, so attempt 1 is genuinely short.
    const full = dumpGz(20_000, 2000);
    const srv = await serve([full.subarray(0, Math.floor(full.length * 0.25)), full]);
    const out = join(dir, 'balances.tsv.gz');
    const retries: number[] = [];
    try {
      const res = await fetchLoyceRichlist({
        url: srv.url,
        outPath: out,
        minSats: 100_000_000,
        attempts: 3,
        retryDelayMs: 0,
        onRetry: (attempt) => retries.push(attempt)
      });
      assert.equal(res.attempts, 2);
      assert.equal(res.kept, 20_000);
      assert.deepEqual(retries, [1]);
      assert.equal(srv.hits(), 2);
      gunzipSync(readFileSync(out));
    } finally {
      await srv.close();
    }
  })
);

test(
  'a source that dies after the cutoff still counts as complete',
  withTmp(async (dir) => {
    // Everything at or above minSats was already read, so the rest of the dump
    // is data we would have thrown away — no reason to fail or retry.
    const full = dumpGz(50, 200_000);
    const srv = await serve([full.subarray(0, Math.floor(full.length * 0.5))]);
    const out = join(dir, 'balances.tsv.gz');
    try {
      const res = await fetchLoyceRichlist({
        url: srv.url,
        outPath: out,
        minSats: 100_000_000,
        attempts: 1
      });
      assert.equal(res.hitCutoff, true);
      assert.equal(res.kept, 50);
      assert.equal(srv.hits(), 1);
      gunzipSync(readFileSync(out));
    } finally {
      await srv.close();
    }
  })
);
