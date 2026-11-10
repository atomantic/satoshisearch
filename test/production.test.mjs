import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run separately from the source tests, after building the adapter-node output.
// A successful build alone misses runtime failures in the bundled dependencies.
test('production server renders every page and handles a form action', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'satoshisearch-production-test-'));
  const node = createServer((_request, response) => response.end('840000'));
  let app;
  t.after(async () => {
    for (const server of [app?.server, node]) {
      if (!server?.listening) continue;
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  node.listen(0, '127.0.0.1');
  await once(node, 'listening');
  Object.assign(process.env, {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: '0',
    PROTOCOL_HEADER: 'x-forwarded-proto',
    DATA_DIR: dataDir,
    MEMPOOL_API_URL: `http://127.0.0.1:${node.address().port}`,
    BITCOIN_RPC_URL: '',
    FULCRUM_HOST: '',
    SWEEP_DRY_RUN: 'true',
    RESCUE_DEST_ADDRESS: '',
    VAULT_KEY_HEX: '',
    RESCUE_WEBHOOK_URL: '',
    RESCUE_NOTIFY_CMD: ''
  });
  for (const name of ['ORIGIN', 'HOST_HEADER', 'PORT_HEADER', 'SOCKET_PATH']) {
    delete process.env[name];
  }

  ({ server: app } = await import('../build/index.js'));
  if (!app.server.listening) await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  for (const path of ['/', '/satoshi', '/puzzles', '/keyspace', '/grinder', '/rescue', '/settings']) {
    const response = await fetch(origin + path, {
      headers: { cookie: 'session=hello%20world', 'x-forwarded-proto': 'http' },
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(response.status, 200, `GET ${path}`);
    assert.match(await response.text(), /satoshi/);
  }

  const response = await fetch(`${origin}/rescue?/verify`, {
    method: 'POST',
    headers: {
      origin,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-proto': 'http'
    },
    body: '',
    signal: AbortSignal.timeout(5000)
  });
  const body = await response.text();
  assert.equal(response.status, 200, `POST /rescue?/verify: ${body}`);
  const result = JSON.parse(body);
  assert.equal(result.type, 'success');
  assert.equal(result.status, 200);
});
