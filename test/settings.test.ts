import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('settings save/load/password-keep/clear round-trip in DATA_DIR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-settings-'));
  process.env.DATA_DIR = dir;
  process.env.__SS_DOTENV_LOADED = '1';
  // Clear any prior module cache of config/settings by dynamic import after env set.
  // config.ts loads once — force dataDir via env before first import in this process.
  // This file is loaded fresh by the test runner per process for test/*.test.ts files.
  const { updateSettings, loadSettings, clearBitcoinRpcSettings, effectiveBitcoinRpc, bitcoinRpcPublicView } =
    await import('../src/lib/server/settings.ts');

  const path = join(dir, 'settings.json');
  assert.equal(existsSync(path), false);

  updateSettings({
    bitcoinRpc: {
      url: 'http://100.104.209.94:8332',
      user: 'umbrel',
      password: 's3cret',
      cookie: ''
    }
  });
  assert.ok(existsSync(path));
  const disk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(disk.bitcoinRpc.password, 's3cret');

  // Blank password keeps previous
  updateSettings({
    bitcoinRpc: { url: 'http://100.104.209.94:8332', user: 'umbrel', password: '' }
  });
  assert.equal(loadSettings().bitcoinRpc.password, 's3cret');

  const view = bitcoinRpcPublicView();
  assert.equal(view.passwordSet, true);
  assert.equal(view.url, 'http://100.104.209.94:8332');
  assert.equal(view.source, 'settings');

  const eff = effectiveBitcoinRpc();
  assert.equal(eff.password, 's3cret');
  assert.equal(eff.user, 'umbrel');

  clearBitcoinRpcSettings();
  assert.equal(loadSettings().bitcoinRpc.url, '');
  assert.equal(loadSettings().bitcoinRpc.password, '');

  rmSync(dir, { recursive: true, force: true });
});

test('kangaroo remote-gpu mode resolves wrapper cmd and SSH fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-kang-'));
  const prev = process.env.DATA_DIR;
  const prevEnv: Record<string, string | undefined> = {
    KANGAROO_MODE: process.env.KANGAROO_MODE,
    KANGAROO_BACKEND: process.env.KANGAROO_BACKEND,
    KANGAROO_SSH: process.env.KANGAROO_SSH,
    KANGAROO_EXTERNAL_CMD: process.env.KANGAROO_EXTERNAL_CMD
  };
  process.env.DATA_DIR = dir;
  delete process.env.KANGAROO_MODE;
  delete process.env.KANGAROO_BACKEND;
  delete process.env.KANGAROO_SSH;
  delete process.env.KANGAROO_EXTERNAL_CMD;
  try {
    const {
      updateSettings,
      effectiveKangaroo,
      kangarooModeToBackend,
      DEFAULT_KANGAROO_SSH_WRAPPER
    } = await import('../src/lib/server/settings.ts');

    updateSettings({
      kangaroo: {
        mode: 'remote-gpu',
        backend: kangarooModeToBackend('remote-gpu'),
        sshHost: 'gpu@3090.local',
        remoteBin: '/opt/Kangaroo/kangaroo',
        wrapperPath: '',
        externalCmd: '',
        jlpBin: '',
        jlpExtraArgs: '-d 16',
        jlpGpuId: '0',
        jlpUseGpu: true,
        sshOpts: '-o BatchMode=yes'
      }
    });
    const k = effectiveKangaroo();
    assert.equal(k.mode, 'remote-gpu');
    assert.equal(k.backend, 'external');
    assert.equal(k.sshHost, 'gpu@3090.local');
    assert.equal(k.remoteBin, '/opt/Kangaroo/kangaroo');
    assert.equal(k.wrapperPath, DEFAULT_KANGAROO_SSH_WRAPPER);
    assert.equal(k.externalCmd, `${DEFAULT_KANGAROO_SSH_WRAPPER} {pubkey} {lo} {hi}`);
    assert.equal(k.jlpExtraArgs, '-d 16');

    updateSettings({
      kangaroo: {
        mode: 'cpu',
        backend: 'cpu',
        sshHost: 'gpu@3090.local', // keep host when switching away
        remoteBin: '/opt/Kangaroo/kangaroo',
        wrapperPath: '',
        externalCmd: '',
        jlpBin: '',
        jlpExtraArgs: '',
        jlpGpuId: '',
        jlpUseGpu: null,
        sshOpts: ''
      }
    });
    const k2 = effectiveKangaroo();
    assert.equal(k2.mode, 'cpu');
    assert.equal(k2.backend, 'cpu');
    assert.equal(k2.sshHost, 'gpu@3090.local');
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grind pace settings resolve light workers and throttle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-grind-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const { updateSettings, effectiveGrind } = await import('../src/lib/server/settings.ts');
    // default normal
    let g = effectiveGrind();
    assert.equal(g.pace, 'normal');
    assert.ok(g.maxWorkers >= 1);
    assert.equal(g.throttleMs, 0);

    updateSettings({ grind: { pace: 'light', maxWorkers: null, throttleMs: null } });
    g = effectiveGrind();
    assert.equal(g.pace, 'light');
    assert.equal(g.maxWorkers, 2);
    assert.equal(g.throttleMs, 150);
    assert.ok(g.batchScale < 1);

    updateSettings({ grind: { pace: 'light', maxWorkers: 1, throttleMs: 500 } });
    g = effectiveGrind();
    assert.equal(g.maxWorkers, 1);
    assert.equal(g.throttleMs, 500);
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rescue/runtime/richlist settings round-trip and fall back to env when unset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-settings-'));
  process.env.DATA_DIR = dir;
  process.env.__SS_DOTENV_LOADED = '1';
  const { updateSettings, clearRescueSettings, effectiveRescue, effectiveRuntime, effectiveRichlist, mayAutoSweep } =
    await import('../src/lib/server/settings.ts');

  // Nothing set yet — falls back to config.ts's hardcoded defaults (no env
  // var and no settings.json field is actually set, so source is 'none').
  const before = effectiveRescue();
  assert.equal(before.source, 'none');
  assert.equal(before.dryRun, true);
  assert.equal(mayAutoSweep('puzzle'), true);
  assert.equal(mayAutoSweep('richlist'), false);

  updateSettings({
    rescue: {
      destAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      dryRun: false,
      dustSats: 5000,
      autoBuckets: ['puzzle', 'richlist'],
      whitehatAttested: true
    },
    runtime: { mempoolApiUrl: 'http://node.example:3006', concurrency: 4, coinbaseMaxHeight: 1000 },
    richlist: { minSats: 50_000_000, scriptPolicy: 'p2wpkh', loyceUrl: 'http://example.test/dump.tsv.gz' }
  });

  const rescue = effectiveRescue();
  assert.equal(rescue.source, 'settings');
  assert.equal(rescue.destAddress, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  assert.equal(rescue.dryRun, false);
  assert.equal(rescue.dustSats, 5000);
  assert.deepEqual([...rescue.autoBuckets].sort(), ['puzzle', 'richlist']);
  assert.equal(rescue.whitehatAttested, true);
  assert.equal(mayAutoSweep('richlist'), true);
  assert.equal(mayAutoSweep('coldcard'), false);

  const runtime = effectiveRuntime();
  assert.equal(runtime.mempoolApiUrl, 'http://node.example:3006');
  assert.equal(runtime.concurrency, 4);
  assert.equal(runtime.coinbaseMaxHeight, 1000);

  const richlist = effectiveRichlist();
  assert.equal(richlist.minSats, 50_000_000);
  assert.equal(richlist.scriptPolicy, 'p2wpkh');
  assert.equal(richlist.loyceUrl, 'http://example.test/dump.tsv.gz');

  clearRescueSettings();
  assert.equal(effectiveRescue().source, 'none');
  assert.equal(effectiveRescue().destAddress, '');

  rmSync(dir, { recursive: true, force: true });
});

test('generateVaultKey only sets a key once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-settings-'));
  process.env.DATA_DIR = dir;
  process.env.__SS_DOTENV_LOADED = '1';
  const { generateVaultKey, effectiveVaultKeyHex, vaultKeyStatusView } = await import(
    '../src/lib/server/settings.ts'
  );

  assert.equal(vaultKeyStatusView().configured, false);
  const first = generateVaultKey();
  assert.equal(first.generated, true);
  const key = effectiveVaultKeyHex();
  assert.match(key, /^[0-9a-fA-F]{64}$/);
  assert.equal(vaultKeyStatusView().configured, true);

  const second = generateVaultKey();
  assert.equal(second.generated, false);
  assert.equal(effectiveVaultKeyHex(), key); // unchanged

  rmSync(dir, { recursive: true, force: true });
});
