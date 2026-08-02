import type { PageServerLoad, Actions } from './$types';
import { fail } from '@sveltejs/kit';
import { config, WHITEHAT_ATTESTATION_TEXT, BUCKETS } from '$server/config';
import { openDb } from '$server/db';
import { tipHeight, recommendedFees } from '$server/mempool';
import { isVaultConfigured } from '$server/rescue/vault';
import { isLocalNode } from '$server/links';
import { indexPuzzles } from '$server/indexer/puzzles';
import { sweep } from '$server/sweep';
import { decodeBitcoinAddress, SINGLE_KEY_SCRIPT_TYPE_LIST } from '$server/script';
import { generateRescueWallet } from '$server/bitcoin/wallet';
import {
  bitcoinRpcPublicView,
  updateSettings,
  clearBitcoinRpcSettings,
  clearRescueSettings,
  loadSettings,
  effectiveRescue,
  effectiveRuntime,
  effectiveRichlist,
  effectiveGrind,
  effectiveKangaroo,
  normalizeKangarooBackend,
  normalizeKangarooMode,
  kangarooModeToBackend,
  DEFAULT_KANGAROO_SSH_WRAPPER,
  DEFAULT_KANGAROO_REMOTE_BIN,
  vaultKeyStatusView,
  generateVaultKey
} from '$server/settings';
import { kangarooAvailability } from '$server/grinder/kangaroo-backends';
import { spawnSync } from 'node:child_process';
import { getBlockchainInfo, isRpcConfigured, resolveRpcAuth } from '$server/bitcoin/rpc';
import { audit } from '$server/rescue/audit';

export const load: PageServerLoad = async () => {
  const db = openDb();
  const counts = db
    .prepare(`SELECT dataset, COUNT(*) c FROM target GROUP BY dataset`)
    .all() as Array<{ dataset: string; c: number }>;
  const runs = db
    .prepare(`SELECT kind, MAX(finished_at) last, SUM(processed) processed FROM scan_run GROUP BY kind`)
    .all() as Array<{ kind: string; last: number | null; processed: number }>;

  // The mempool/Esplora and Bitcoin Core probes are independent — run them
  // together so a slow node doesn't add its latency to the other's. Each keeps
  // its own catch so a failing probe degrades to a status line, never a 500.
  const [node, rpcProbe] = await Promise.all([
    Promise.all([tipHeight(), recommendedFees().catch(() => null)])
      .then(([tip, fees]) => ({
        ok: true,
        tip: tip as number | null,
        fastestFee: fees?.fastestFee ?? null
      }))
      .catch(() => ({ ok: false, tip: null as number | null, fastestFee: null as number | null })),
    isRpcConfigured()
      ? getBlockchainInfo()
          .then((info) => ({
            ok: true,
            message: `${info.chain} · height ${info.blocks.toLocaleString()} · ${info.bestblockhash.slice(0, 12)}…`
          }))
          .catch((e) => ({ ok: false, message: String(e instanceof Error ? e.message : e) }))
      : Promise.resolve(null)
  ]);

  const rpcView = bitcoinRpcPublicView();

  const rescue = effectiveRescue();
  const runtime = effectiveRuntime();
  const grind = effectiveGrind();
  const kangaroo = effectiveKangaroo();
  const kangarooAvail = kangarooAvailability();
  const richlist = effectiveRichlist();

  return {
    node,
    isLocal: isLocalNode(),
    buckets: [...BUCKETS],
    scriptTypes: [...SINGLE_KEY_SCRIPT_TYPE_LIST],
    dataDir: config.dataDir,
    rescue: {
      destAddress: rescue.destAddress,
      dryRun: rescue.dryRun,
      dustSats: rescue.dustSats,
      autoBuckets: [...rescue.autoBuckets],
      whitehatAttested: rescue.whitehatAttested,
      source: rescue.source,
      vaultReady: isVaultConfigured()
    },
    runtime: {
      mempoolApiUrl: runtime.mempoolApiUrl,
      concurrency: runtime.concurrency,
      coinbaseMaxHeight: runtime.coinbaseMaxHeight,
      source: runtime.source
    },
    grind: {
      pace: grind.pace,
      maxWorkers: grind.maxWorkers,
      throttleMs: grind.throttleMs,
      batchScale: grind.batchScale,
      source: grind.source,
      /** Raw overrides as stored (null = use pace default). */
      stored: loadSettings().grind
    },
    kangaroo: {
      mode: kangaroo.mode,
      backend: kangaroo.backend,
      jlpBin: kangaroo.jlpBin,
      jlpExtraArgs: kangaroo.jlpExtraArgs,
      jlpUseGpu: kangaroo.jlpUseGpu,
      jlpGpuId: kangaroo.jlpGpuId,
      externalCmd: kangaroo.externalCmd,
      sshHost: kangaroo.sshHost,
      sshOpts: kangaroo.sshOpts,
      remoteBin: kangaroo.remoteBin,
      wrapperPath: kangaroo.wrapperPath,
      source: kangaroo.source,
      available: kangarooAvail.available,
      detail: kangarooAvail.detail,
      defaults: {
        wrapperPath: DEFAULT_KANGAROO_SSH_WRAPPER,
        remoteBin: DEFAULT_KANGAROO_REMOTE_BIN
      },
      stored: loadSettings().kangaroo
    },
    richlist: {
      minSats: richlist.minSats,
      scriptPolicy: richlist.scriptPolicy,
      loyceUrl: richlist.loyceUrl,
      source: richlist.source
    },
    vault: vaultKeyStatusView(),
    bitcoinRpc: rpcView,
    rpcProbe,
    fulcrum: loadSettings().fulcrum,
    counts,
    runs
  };
};

export const actions: Actions = {
  indexPuzzles: async () => {
    const rows = await indexPuzzles();
    return { done: `Re-indexed ${rows.length} puzzles.` };
  },
  recheckPuzzles: async () => {
    const res = await sweep({ datasets: ['puzzle'], onlyFunded: true });
    return { done: `Re-checked ${res.scanned} puzzle targets · ${res.changed} changed.` };
  },
  recheckFunded: async () => {
    const res = await sweep({ onlyFunded: true });
    return {
      done: `Re-checked ${res.scanned} funded targets in ${(res.elapsedMs / 1000).toFixed(1)}s · ${res.moved.length} moved.`
    };
  },

  saveBitcoinRpc: async ({ request }) => {
    const data = await request.formData();
    const url = String(data.get('url') ?? '').trim();
    const user = String(data.get('user') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const cookie = String(data.get('cookie') ?? '').trim();
    const fulcrumHost = String(data.get('fulcrumHost') ?? '').trim();
    const fulcrumPort = Number(data.get('fulcrumPort') ?? 50002);

    if (url && !/^https?:\/\//i.test(url)) {
      return fail(400, { error: 'RPC URL must start with http:// or https://' });
    }

    const saved = updateSettings(
      {
        bitcoinRpc: { url, user, password, cookie },
        fulcrum: {
          host: fulcrumHost,
          port: Number.isFinite(fulcrumPort) && fulcrumPort > 0 ? fulcrumPort : 50002
        }
      },
      { keepPasswordIfEmpty: true }
    );

    audit('settings-rpc-saved', {
      url: saved.bitcoinRpc.url || null,
      user: saved.bitcoinRpc.user || null,
      passwordSet: !!saved.bitcoinRpc.password,
      cookieSet: !!saved.bitcoinRpc.cookie,
      fulcrumHost: saved.fulcrum.host || null,
      fulcrumPort: saved.fulcrum.port
    });

    return { done: 'Saved Bitcoin RPC settings to data/settings.json.' };
  },

  testBitcoinRpc: async ({ request }) => {
    const data = await request.formData();
    // Optional: test form values without saving (password empty → use stored)
    const url = String(data.get('url') ?? '').trim();
    const user = String(data.get('user') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const cookie = String(data.get('cookie') ?? '').trim();

    try {
      // resolveRpcAuth already owns the precedence (override → settings → env →
      // cookie file). Blank fields must be passed as undefined, not '', because
      // it merges user/password with ?? — an empty string would win over the
      // stored credential instead of falling through to it.
      const auth = resolveRpcAuth({
        url: url || undefined,
        user: user || undefined,
        password: password || undefined,
        cookie: cookie || undefined
      });

      const info = await getBlockchainInfo(auth);
      return {
        done: `RPC OK — ${info.chain} at height ${info.blocks.toLocaleString()} (${info.bestblockhash.slice(0, 16)}…).`
      };
    } catch (e) {
      return fail(400, { error: `RPC test failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  },

  clearBitcoinRpc: async () => {
    clearBitcoinRpcSettings();
    audit('settings-rpc-cleared', {});
    return { done: 'Cleared Bitcoin RPC settings from data/settings.json (env fallbacks still apply if set).' };
  },

  saveRescue: async ({ request }) => {
    const data = await request.formData();
    const destAddress = String(data.get('destAddress') ?? '').trim();
    const dryRun = data.get('dryRun') === 'on';
    const dustSats = Number(data.get('dustSats') ?? 10_000);
    const autoBuckets = data.getAll('autoBuckets').map((b) => String(b));
    const attestationInput = String(data.get('whitehatAttestation') ?? '').trim().toLowerCase();
    const whitehatAttested = attestationInput === WHITEHAT_ATTESTATION_TEXT;

    if (destAddress && !decodeBitcoinAddress(destAddress)) {
      return fail(400, { error: `"${destAddress}" is not a valid mainnet Bitcoin address.` });
    }
    if (!Number.isFinite(dustSats) || dustSats < 0) {
      return fail(400, { error: 'Dust floor must be a non-negative number of sats.' });
    }

    updateSettings({ rescue: { destAddress, dryRun, dustSats, autoBuckets, whitehatAttested } });

    audit('settings-rescue-saved', {
      destAddress: destAddress || null,
      dryRun,
      dustSats,
      autoBuckets,
      whitehatAttested
    });

    return { done: 'Saved rescue policy to data/settings.json.' };
  },

  clearRescue: async () => {
    clearRescueSettings();
    audit('settings-rescue-cleared', {});
    return { done: 'Cleared rescue policy overrides from data/settings.json (env fallbacks apply if set).' };
  },

  generateRescueWallet: async () => {
    const wallet = generateRescueWallet();
    audit('settings-rescue-wallet-generated', { address: wallet.address, path: wallet.path });
    return { mnemonic: wallet.mnemonic, address: wallet.address };
  },

  useGeneratedRescueAddress: async ({ request }) => {
    const data = await request.formData();
    const address = String(data.get('address') ?? '').trim();
    if (!address || !decodeBitcoinAddress(address)) {
      return fail(400, { error: 'No valid generated address to use — generate a new wallet first.' });
    }
    updateSettings({ rescue: { destAddress: address } });
    audit('settings-rescue-address-set', { address, generated: true });
    return { done: `Rescue destination set to ${address}.` };
  },

  saveRuntime: async ({ request }) => {
    const data = await request.formData();
    const mempoolApiUrl = String(data.get('mempoolApiUrl') ?? '').trim();
    const concurrency = Number(data.get('concurrency') ?? 8);
    const coinbaseMaxHeight = Number(data.get('coinbaseMaxHeight') ?? 50_000);

    if (mempoolApiUrl && !/^https?:\/\//i.test(mempoolApiUrl)) {
      return fail(400, { error: 'Mempool API URL must start with http:// or https://' });
    }
    if (!Number.isFinite(concurrency) || concurrency < 1) {
      return fail(400, { error: 'Concurrency must be a positive number.' });
    }
    if (!Number.isFinite(coinbaseMaxHeight) || coinbaseMaxHeight < 0) {
      return fail(400, { error: 'Coinbase max height must be a non-negative number.' });
    }

    updateSettings({ runtime: { mempoolApiUrl, concurrency, coinbaseMaxHeight } });
    audit('settings-runtime-saved', { mempoolApiUrl: mempoolApiUrl || null, concurrency, coinbaseMaxHeight });
    return { done: 'Saved runtime settings to data/settings.json.' };
  },

  saveGrind: async ({ request }) => {
    const data = await request.formData();
    const paceRaw = String(data.get('pace') ?? 'normal').trim();
    const pace = paceRaw === 'light' || paceRaw === 'full' || paceRaw === 'normal' ? paceRaw : 'normal';
    const maxWorkersRaw = String(data.get('maxWorkers') ?? '').trim();
    const throttleRaw = String(data.get('throttleMs') ?? '').trim();
    const maxWorkers =
      maxWorkersRaw === '' ? null : Number(maxWorkersRaw);
    const throttleMs = throttleRaw === '' ? null : Number(throttleRaw);

    if (maxWorkers !== null && (!Number.isFinite(maxWorkers) || maxWorkers < 0 || maxWorkers > 256)) {
      return fail(400, { error: 'Max workers must be empty (auto) or 0–256.' });
    }
    if (throttleMs !== null && (!Number.isFinite(throttleMs) || throttleMs < 0 || throttleMs > 60_000)) {
      return fail(400, { error: 'Throttle must be empty (auto) or 0–60000 ms.' });
    }

    updateSettings({
      grind: {
        pace,
        maxWorkers: maxWorkers === 0 ? null : maxWorkers,
        throttleMs
      }
    });
    audit('settings-grind-saved', { pace, maxWorkers, throttleMs });
    return {
      done: `Saved grinder pace: ${pace}${maxWorkers ? ` · max ${maxWorkers} workers` : ''}${throttleMs != null ? ` · ${throttleMs}ms throttle` : ''}. Takes effect on the next grind start.`
    };
  },

  saveKangaroo: async ({ request }) => {
    const data = await request.formData();
    const modeRaw = String(data.get('mode') ?? data.get('backend') ?? '').trim();
    // Accept legacy backend values (cpu|jlp|external) and new mode values.
    let mode = normalizeKangarooMode(modeRaw);
    if (!mode) {
      const legacy = normalizeKangarooBackend(modeRaw);
      if (legacy === 'jlp') mode = 'local-gpu';
      else if (legacy === 'external') mode = 'custom';
      else if (legacy === 'cpu') mode = 'cpu';
    }
    if (!mode) mode = 'cpu';

    const jlpBin = String(data.get('jlpBin') ?? '').trim();
    const jlpExtraArgs = String(data.get('jlpExtraArgs') ?? '').trim();
    const jlpGpuId = String(data.get('jlpGpuId') ?? '').trim();
    const jlpUseGpu = data.get('jlpUseGpu') === 'on';
    const externalCmd = String(data.get('externalCmd') ?? '').trim();
    const sshHost = String(data.get('sshHost') ?? '').trim();
    const sshOpts = String(data.get('sshOpts') ?? '').trim();
    const remoteBin = String(data.get('remoteBin') ?? '').trim();
    const wrapperPath = String(data.get('wrapperPath') ?? '').trim();

    if (mode === 'remote-gpu' && !sshHost) {
      return fail(400, { error: 'Remote GPU requires an SSH host (user@gpu-box).' });
    }
    if (mode === 'local-gpu' && !jlpBin) {
      return fail(400, { error: 'Local GPU requires a path to the JeanLucPons (or compatible) binary.' });
    }
    if (mode === 'custom' && !externalCmd) {
      return fail(400, { error: 'Custom mode requires an external command template.' });
    }

    const backend = kangarooModeToBackend(mode);
    // remote-gpu: store empty externalCmd so effectiveKangaroo auto-builds the wrapper.
    const storedExternal =
      mode === 'remote-gpu' ? '' : mode === 'custom' ? externalCmd : externalCmd;

    updateSettings({
      kangaroo: {
        mode,
        backend,
        jlpBin,
        jlpExtraArgs,
        jlpGpuId,
        jlpUseGpu,
        externalCmd: storedExternal,
        sshHost,
        sshOpts,
        remoteBin,
        wrapperPath
      }
    });
    audit('settings-kangaroo-saved', {
      mode,
      backend,
      jlpBin: jlpBin || null,
      jlpUseGpu,
      jlpGpuId: jlpGpuId || null,
      sshHost: sshHost || null,
      remoteBin: remoteBin || null,
      externalCmd: storedExternal ? '[set]' : null
    });
    return {
      done: `Saved kangaroo runner: ${mode}${sshHost ? ` · ${sshHost}` : ''}. Takes effect on the next kangaroo start.`
    };
  },

  testKangarooRemote: async ({ request }) => {
    const data = await request.formData();
    // Prefer form fields (unsaved) so operators can test before save.
    const sshHost =
      String(data.get('sshHost') ?? '').trim() || effectiveKangaroo().sshHost;
    const sshOpts =
      String(data.get('sshOpts') ?? '').trim() || effectiveKangaroo().sshOpts;
    const remoteBin =
      String(data.get('remoteBin') ?? '').trim() ||
      effectiveKangaroo().remoteBin ||
      DEFAULT_KANGAROO_REMOTE_BIN;

    if (!sshHost) {
      return fail(400, { error: 'SSH host is empty — set user@gpu-box first.' });
    }

    const opts = sshOpts
      ? sshOpts.split(/\s+/).filter(Boolean)
      : ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8'];

    const probe = spawnSync(
      'ssh',
      [...opts, sshHost, `nvidia-smi -L 2>/dev/null; command -v '${remoteBin}' && '${remoteBin}' -l 2>/dev/null | head -20; echo __SS_OK__`],
      { encoding: 'utf8', timeout: 20_000 }
    );

    const out = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
    if (probe.error) {
      return fail(400, { error: `SSH failed to start: ${probe.error.message}` });
    }
    if (probe.status !== 0 && !out.includes('__SS_OK__')) {
      return fail(400, {
        error: `SSH probe failed (exit ${probe.status}): ${out.slice(0, 500) || 'no output — check keys / host / BatchMode'}`
      });
    }

    const clean = out.replace(/\n?__SS_OK__\n?/g, '').trim();
    audit('settings-kangaroo-remote-test', { sshHost, remoteBin, ok: true });
    return {
      done: `Remote GPU probe OK · ${sshHost}\n${clean.slice(0, 800) || '(connected; no nvidia-smi / -l output)'}`
    };
  },

  saveRichlist: async ({ request }) => {
    const data = await request.formData();
    const minSats = Number(data.get('minSats') ?? 100_000_000);
    const scriptPolicy = data.getAll('scriptPolicy').map(String).join(',');
    const loyceUrl = String(data.get('loyceUrl') ?? '').trim();

    if (!Number.isFinite(minSats) || minSats < 0) {
      return fail(400, { error: 'Minimum balance must be a non-negative number of sats.' });
    }
    if (loyceUrl && !/^https?:\/\//i.test(loyceUrl)) {
      return fail(400, { error: 'Loyce URL must start with http:// or https://' });
    }

    updateSettings({ richlist: { minSats, scriptPolicy, loyceUrl } });
    audit('settings-richlist-saved', { minSats, scriptPolicy, loyceUrl: loyceUrl || null });
    return { done: 'Saved richlist thresholds to data/settings.json.' };
  },

  generateVaultKey: async () => {
    const result = generateVaultKey();
    if (!result.generated) {
      return fail(400, {
        error:
          'A vault key is already configured — rotating it would orphan already-encrypted recovered keys, so this cannot be done from the UI.'
      });
    }
    audit('settings-vault-key-generated', {});
    return { done: 'Generated and saved a new vault key to data/settings.json (mode 0600).' };
  }
};
