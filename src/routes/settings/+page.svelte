<script lang="ts">
  import type { PageData, ActionData } from './$types';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { timeAgo } from '$lib/format';
  export let data: PageData;
  export let form: ActionData;
  let busy = '';

  /**
   * Standard enhance handler for the plain "submit and show a busy label" forms:
   * flag `busy` with `name` while in flight, then re-render without resetting
   * the form (default `reset: true` would wipe bound inputs back to their
   * initial HTML values).
   */
  const track =
    (name: string): SubmitFunction =>
    () => {
      busy = name;
      return async ({ update }) => {
        await update({ reset: false });
        busy = '';
      };
    };

  const SCRIPT_TYPES = data.scriptTypes;

  // Form-bound so test uses current field values
  let rpcUrl = data.bitcoinRpc.url;
  let rpcUser = data.bitcoinRpc.user;
  let rpcPassword = '';
  let rpcCookie = data.bitcoinRpc.cookie;
  let fulcrumHost = data.fulcrum.host;

  // Rescue policy
  let rescueDestAddress = data.rescue.destAddress;
  let rescueDryRun = data.rescue.dryRun;
  let rescueAutoBuckets = [...data.rescue.autoBuckets];

  // Generated-wallet reveal flow — never sent anywhere but this one response,
  // never persisted. Only the address (once confirmed) is saved.
  let generatedWallet: { mnemonic: string; address: string } | null = null;
  let walletSavedConfirmed = false;

  // Richlist
  let richlistMinSats = data.richlist.minSats;
  let richlistScriptPolicy = data.richlist.scriptPolicy.split(',').map((s) => s.trim()).filter(Boolean);
  $: richlistMinBtc = (richlistMinSats / 1e8).toFixed(4);

  // Grinder pace
  let grindPace = data.grind.pace;
  let grindMaxWorkers =
    data.grind.stored.maxWorkers != null ? String(data.grind.stored.maxWorkers) : '';
  let grindThrottleMs =
    data.grind.stored.throttleMs != null ? String(data.grind.stored.throttleMs) : '';

  // Kangaroo runner (cpu / local GPU / remote GPU / custom)
  let kangMode =
    data.kangaroo.stored.mode ||
    data.kangaroo.mode ||
    'cpu';
  let kangJlpBin = data.kangaroo.stored.jlpBin || data.kangaroo.jlpBin || '';
  let kangJlpExtra = data.kangaroo.stored.jlpExtraArgs || data.kangaroo.jlpExtraArgs || '';
  let kangJlpGpuId = data.kangaroo.stored.jlpGpuId || data.kangaroo.jlpGpuId || '';
  let kangJlpUseGpu = data.kangaroo.stored.jlpUseGpu ?? data.kangaroo.jlpUseGpu;
  let kangExternal = data.kangaroo.stored.externalCmd || data.kangaroo.externalCmd || '';
  let kangSshHost = data.kangaroo.stored.sshHost || data.kangaroo.sshHost || '';
  let kangSshOpts = data.kangaroo.stored.sshOpts || data.kangaroo.sshOpts || '';
  let kangRemoteBin =
    data.kangaroo.stored.remoteBin || data.kangaroo.remoteBin || data.kangaroo.defaults.remoteBin;
  let kangWrapper =
    data.kangaroo.stored.wrapperPath ||
    data.kangaroo.wrapperPath ||
    data.kangaroo.defaults.wrapperPath;
</script>

<svelte:head><title>Settings · satoshisearch</title></svelte:head>

<h1>Settings</h1>
<p class="muted">
  Everything below is saved to <code class="mono">{data.bitcoinRpc.settingsPath}</code> (mode 0600) and
  overrides <code>.env</code> — no restart required. A field left as its default falls back to the
  matching env var if one is set.
</p>

{#if form?.done}<div class="toast ok-toast">{form.done}</div>{/if}
{#if form?.error}<div class="toast err-toast">{form.error}</div>{/if}

<div class="card">
  <div class="k">Esplora / Mempool</div>
  <div class="row">
    <span class="dot" class:ok={data.node.ok} class:bad={!data.node.ok}></span>
    {#if data.node.ok}
      Connected to <span class="mono">{data.runtime.mempoolApiUrl}</span> · tip
      <b class="num">{data.node.tip?.toLocaleString()}</b>
      · {data.node.fastestFee ?? '—'} sat/vB · {data.isLocal ? 'local node (private)' : 'public mempool.space'}
    {:else}
      <span class="bad">Unreachable at {data.runtime.mempoolApiUrl}</span> — set below or via <code>MEMPOOL_API_URL</code>.
    {/if}
  </div>
</div>

<div class="card">
  <div class="k">Bitcoin Core RPC</div>
  <p class="faint small top-note">
    Used for <code>dumptxoutset</code> / chain tip when building a richlist from your own UTXO set.
    Umbrel UI ports (<code>:2100</code>) are not RPC — use <code>:8332</code> (or your app’s RPC bind).
    Source: <b>{data.bitcoinRpc.source}</b>
    {#if data.bitcoinRpc.updatedAt}
      · saved {timeAgo(data.bitcoinRpc.updatedAt)}
    {/if}
  </p>

  {#if data.rpcProbe}
    <div class="row probe" class:ok={data.rpcProbe.ok} class:bad={!data.rpcProbe.ok}>
      <span class="dot" class:ok={data.rpcProbe.ok} class:bad={!data.rpcProbe.ok}></span>
      {data.rpcProbe.message}
    </div>
  {:else}
    <div class="row probe faint">Not configured — enter URL + user/password (or cookie path) below.</div>
  {/if}

  <form
    method="POST"
    action="?/saveBitcoinRpc"
    class="rpc-form"
    use:enhance={({ action }) => {
      // SvelteKit actions use ?/actionName in the URL
      const act = action.href.split('?/').pop() || 'saveBitcoinRpc';
      busy = act === 'testBitcoinRpc' ? 'test-rpc' : act === 'clearBitcoinRpc' ? 'clear-rpc' : 'save-rpc';
      return async ({ update, result }) => {
        // Default update({ reset: true }) wipes bound inputs back to initial HTML
        // values — bad for Test (and Save). Only Clear should empty the form.
        await update({ reset: false });
        busy = '';
        if (act === 'saveBitcoinRpc' && result.type === 'success') {
          rpcPassword = ''; // don't keep plaintext in the field after save
        }
        if (act === 'clearBitcoinRpc' && result.type === 'success') {
          rpcUrl = '';
          rpcUser = '';
          rpcPassword = '';
          rpcCookie = '';
          fulcrumHost = '';
        }
      };
    }}
  >
    <label>
      <span>RPC URL</span>
      <input name="url" type="url" placeholder="http://100.104.209.94:8332" bind:value={rpcUrl} autocomplete="off" />
    </label>
    <div class="rpc-grid">
      <label>
        <span>Username</span>
        <input name="user" type="text" placeholder="bitcoin" bind:value={rpcUser} autocomplete="username" />
      </label>
      <label>
        <span>Password {#if data.bitcoinRpc.passwordSet}<em class="faint">(leave blank to keep)</em>{/if}</span>
        <input
          name="password"
          type="password"
          placeholder={data.bitcoinRpc.passwordSet ? '••••••••' : ''}
          bind:value={rpcPassword}
          autocomplete="new-password"
        />
      </label>
    </div>
    <label>
      <span>
        Cookie path <em class="faint">(optional — used if user/password empty)</em>
        {#if data.bitcoinRpc.cookieFromEnv}<em class="faint">— set from env</em>{/if}
      </span>
      <input
        name="cookie"
        type="text"
        placeholder={data.bitcoinRpc.cookieFromEnv ? '(from env)' : '/data/bitcoin/.cookie'}
        bind:value={rpcCookie}
        autocomplete="off"
      />
    </label>

    <div class="rpc-grid">
      <label>
        <span>Fulcrum host <em class="faint">(optional)</em></span>
        <input name="fulcrumHost" type="text" placeholder="100.104.209.94" bind:value={fulcrumHost} autocomplete="off" />
      </label>
      <label>
        <span>Fulcrum port</span>
        <input name="fulcrumPort" type="number" min="1" max="65535" value={data.fulcrum.port} />
      </label>
    </div>

    <div class="actions">
      <button type="submit" disabled={!!busy}>{busy === 'save-rpc' ? 'Saving…' : 'Save'}</button>
      <button type="submit" formaction="?/testBitcoinRpc" class="secondary" disabled={!!busy}>
        {busy === 'test-rpc' ? 'Testing…' : 'Test connection'}
      </button>
      <button type="submit" formaction="?/clearBitcoinRpc" class="secondary danger" disabled={!!busy}>
        Clear saved
      </button>
    </div>
  </form>
  <p class="faint small">
    Stored at <span class="mono">{data.bitcoinRpc.settingsPath}</span> with mode 0600. Env vars still work as
    fallback when a field is empty here.
  </p>
</div>

<div class="card">
  <div class="k">Indexed data</div>
  <table>
    <tbody>
      {#each data.counts as row}
        <tr><td class="cap">{row.dataset}</td><td class="num r">{row.c.toLocaleString()}</td></tr>
      {/each}
      {#if !data.counts.length}<tr><td class="faint">nothing indexed yet</td></tr>{/if}
    </tbody>
  </table>
  <div class="actions">
    <form
      method="POST"
      action="?/indexPuzzles"
      use:enhance={track('puzzles')}
    >
      <button disabled={!!busy}>{busy === 'puzzles' ? 'Indexing…' : 'Re-index puzzles'}</button>
    </form>
    <form
      method="POST"
      action="?/recheckFunded"
      use:enhance={track('funded')}
    >
      <button disabled={!!busy}>{busy === 'funded' ? 'Checking…' : 'Re-check funded'}</button>
    </form>
  </div>
  <p class="faint small">Large indexing jobs (coinbase, richlist) run from the CLI — see README.</p>
</div>

<div class="card">
  <div class="k">Rescue policy</div>
  <p class="faint small top-note">
    Source: <b>{data.rescue.source}</b> — funds only ever move to the destination below, and only when
    dry-run is off and the bucket/attestation checks below pass.
  </p>

  <div class="actions" style="margin-bottom:12px">
    <form
      method="POST"
      action="?/generateRescueWallet"
      use:enhance={() => {
        busy = 'gen-wallet';
        return async ({ update, result }) => {
          await update({ reset: false });
          busy = '';
          if (result.type === 'success' && result.data) {
            generatedWallet = {
              mnemonic: String(result.data.mnemonic ?? ''),
              address: String(result.data.address ?? '')
            };
            walletSavedConfirmed = false;
          }
        };
      }}
    >
      <button type="submit" class="secondary" disabled={!!busy}>
        {busy === 'gen-wallet' ? 'Generating…' : 'Generate new rescue wallet'}
      </button>
    </form>
  </div>

  {#if generatedWallet}
    <div class="wallet-reveal">
      <p class="danger-note">
        <strong>Write this down now.</strong> This seed phrase will not be shown again and is never stored
        on this server — the app only keeps the address below.
      </p>
      <div class="mnemonic mono">{generatedWallet.mnemonic}</div>
      <p class="faint small">Address: <span class="mono">{generatedWallet.address}</span></p>
      <label class="confirm">
        <input type="checkbox" bind:checked={walletSavedConfirmed} />
        I've securely saved this seed phrase
      </label>
      <div class="actions">
        <form
          method="POST"
          action="?/useGeneratedRescueAddress"
          use:enhance={() => {
            busy = 'use-wallet';
            return async ({ update, result }) => {
              await update({ reset: false });
              busy = '';
              if (result.type === 'success') {
                rescueDestAddress = generatedWallet?.address ?? rescueDestAddress;
                generatedWallet = null;
                walletSavedConfirmed = false;
              }
            };
          }}
        >
          <input type="hidden" name="address" value={generatedWallet.address} />
          <button type="submit" disabled={!walletSavedConfirmed || !!busy}>
            {busy === 'use-wallet' ? 'Saving…' : 'Use this address'}
          </button>
        </form>
        <button
          type="button"
          class="secondary"
          on:click={() => {
            generatedWallet = null;
            walletSavedConfirmed = false;
          }}
        >
          Discard
        </button>
      </div>
    </div>
  {/if}

  <form
    method="POST"
    action="?/saveRescue"
    class="rpc-form"
    use:enhance={({ action }) => {
      const act = action.href.split('?/').pop() || 'saveRescue';
      busy = act === 'clearRescue' ? 'clear-rescue' : 'save-rescue';
      return async ({ update }) => {
        await update({ reset: false });
        busy = '';
      };
    }}
  >
    <label>
      <span>Destination address</span>
      <input
        name="destAddress"
        type="text"
        placeholder="bc1…"
        bind:value={rescueDestAddress}
        autocomplete="off"
      />
    </label>

    <label class="confirm">
      <input type="checkbox" name="dryRun" bind:checked={rescueDryRun} />
      Dry-run (safe — sign transactions but never broadcast)
    </label>
    {#if !rescueDryRun}
      <p class="danger-note">⚠ LIVE — sweeps will broadcast real transactions to the destination above.</p>
    {/if}

    <label>
      <span>Dust floor (sats)</span>
      <input name="dustSats" type="number" min="0" value={data.rescue.dustSats} />
    </label>

    <fieldset class="buckets">
      <legend>Auto-sweep buckets</legend>
      {#each data.buckets as b}
        <label class="bucket-item">
          <input type="checkbox" name="autoBuckets" value={b} bind:group={rescueAutoBuckets} />
          {b}
        </label>
      {/each}
    </fieldset>
    <p class="faint small top-note">
      Only <code>puzzle</code> sweeps automatically without the attestation below — every other bucket may
      touch a living person's funds.
    </p>

    <label>
      <span>White-hat attestation <em class="faint">(required for non-puzzle auto-sweep)</em></span>
      <textarea
        name="whitehatAttestation"
        rows="2"
        placeholder="I attest this is an authorized white-hat rescue and funds will be returned to their owners"
      ></textarea>
    </label>
    <p class="faint small">
      Currently: <b class:ok={data.rescue.whitehatAttested} class:bad={!data.rescue.whitehatAttested}
        >{data.rescue.whitehatAttested ? 'attested' : 'not attested'}</b
      >. Leave blank to keep unattested; must match the sentence above exactly to attest.
    </p>

    <div class="actions">
      <button type="submit" disabled={!!busy}>{busy === 'save-rescue' ? 'Saving…' : 'Save'}</button>
      <button type="submit" formaction="?/clearRescue" class="secondary danger" disabled={!!busy}>
        Clear saved
      </button>
    </div>
  </form>
</div>

<div class="card">
  <div class="k">Runtime</div>
  <p class="faint small top-note">Source: <b>{data.runtime.source}</b></p>
  <form
    method="POST"
    action="?/saveRuntime"
    class="rpc-form"
    use:enhance={track('save-runtime')}
  >
    <label>
      <span>Mempool API URL</span>
      <input
        name="mempoolApiUrl"
        type="url"
        placeholder="http://100.104.209.94:3006"
        value={data.runtime.mempoolApiUrl}
        autocomplete="off"
      />
    </label>
    <div class="rpc-grid">
      <label>
        <span>Request concurrency</span>
        <input name="concurrency" type="number" min="1" value={data.runtime.concurrency} />
      </label>
      <label>
        <span>Coinbase max height</span>
        <input name="coinbaseMaxHeight" type="number" min="0" value={data.runtime.coinbaseMaxHeight} />
      </label>
    </div>
    <div class="actions">
      <button type="submit" disabled={!!busy}>{busy === 'save-runtime' ? 'Saving…' : 'Save'}</button>
    </div>
  </form>
  <p class="faint small">Data dir: <span class="mono">{data.dataDir}</span> (env-only, set via <code>DATA_DIR</code>).</p>
</div>

<div class="card">
  <div class="k">Grinder pace</div>
  <p class="faint small top-note">
    How hard the grinder uses this machine. <b>Light</b> is for overnight exercise without pegging every core.
    Takes effect on the <em>next</em> grind start (stop/start if one is running). Source:
    <b>{data.grind.source}</b> · effective now: <b>{data.grind.pace}</b>,
    <b>{data.grind.maxWorkers}</b> workers, <b>{data.grind.throttleMs}ms</b> throttle.
  </p>
  <form method="POST" action="?/saveGrind" class="rpc-form" use:enhance={track('save-grind')}>
    <fieldset class="pace-set">
      <legend>Pace</legend>
      <label class="pace-item">
        <input type="radio" name="pace" value="light" bind:group={grindPace} />
        <span>
          <b>Light</b>
          <em class="faint">— ~2 workers, pause between batches, smaller work units. Gentle overnight.</em>
        </span>
      </label>
      <label class="pace-item">
        <input type="radio" name="pace" value="normal" bind:group={grindPace} />
        <span>
          <b>Normal</b>
          <em class="faint">— all cores minus one, no throttle. Default.</em>
        </span>
      </label>
      <label class="pace-item">
        <input type="radio" name="pace" value="full" bind:group={grindPace} />
        <span>
          <b>Full</b>
          <em class="faint">— all cores, no throttle. Race mode.</em>
        </span>
      </label>
    </fieldset>
    <div class="rpc-grid">
      <label>
        <span>Max workers <em class="faint">(blank = pace default)</em></span>
        <input
          name="maxWorkers"
          type="number"
          min="0"
          max="256"
          placeholder={String(data.grind.maxWorkers)}
          bind:value={grindMaxWorkers}
        />
      </label>
      <label>
        <span>Throttle ms <em class="faint">(blank = pace default; light=150)</em></span>
        <input
          name="throttleMs"
          type="number"
          min="0"
          max="60000"
          placeholder={String(data.grind.throttleMs)}
          bind:value={grindThrottleMs}
        />
      </label>
    </div>
    <div class="actions">
      <button type="submit" disabled={!!busy}>{busy === 'save-grind' ? 'Saving…' : 'Save grinder pace'}</button>
    </div>
  </form>
</div>

<div class="card">
  <div class="k">Kangaroo runner (CPU / GPU / remote)</div>
  <p class="faint small top-note">
    Exposed-puzzle ECDLP. Source: <b>{data.kangaroo.source}</b> · mode:
    <b class="mono">{data.kangaroo.mode}</b>
    {#if data.kangaroo.available}
      · <span class="ok-text">ready</span>
    {:else}
      · <span class="warn">not ready</span>
    {/if}
    · {data.kangaroo.detail}
  </p>
  <form method="POST" action="?/saveKangaroo" class="rpc-form" use:enhance={track('save-kangaroo')}>
    <fieldset class="pace-set">
      <legend>Where to run kangaroo</legend>
      <label class="pace-item">
        <input type="radio" name="mode" value="cpu" bind:group={kangMode} />
        <span>
          <b>CPU (this machine)</b>
          <em class="faint">— satoshi-kangaroo · default · laptop-friendly.</em>
        </span>
      </label>
      <label class="pace-item">
        <input type="radio" name="mode" value="local-gpu" bind:group={kangMode} />
        <span>
          <b>Local CUDA</b>
          <em class="faint">— JeanLucPons (or compatible) on <em>this</em> host.</em>
        </span>
      </label>
      <label class="pace-item">
        <input type="radio" name="mode" value="remote-gpu" bind:group={kangMode} />
        <span>
          <b>Remote GPU (SSH)</b>
          <em class="faint">— observatory here, kangaroo on your RTX box. Recommended split.</em>
        </span>
      </label>
      <label class="pace-item">
        <input type="radio" name="mode" value="custom" bind:group={kangMode} />
        <span>
          <b>Custom command</b>
          <em class="faint">— any JSONL solver (RCKangaroo wrapper, pool client, …).</em>
        </span>
      </label>
    </fieldset>

    {#if kangMode === 'local-gpu'}
      <div class="rpc-grid kang-panel">
        <label class="full">
          <span>JLP binary on this machine <em class="faint">(KANGAROO_JLP_BIN)</em></span>
          <input name="jlpBin" type="text" class="mono" placeholder="/opt/Kangaroo/kangaroo" bind:value={kangJlpBin} />
        </label>
        <label>
          <span>GPU id(s)</span>
          <input name="jlpGpuId" type="text" class="mono" placeholder="0" bind:value={kangJlpGpuId} />
        </label>
        <label class="check">
          <input type="checkbox" name="jlpUseGpu" bind:checked={kangJlpUseGpu} />
          <span>Pass <span class="mono">-gpu</span></span>
        </label>
        <label class="full">
          <span>Extra args</span>
          <input name="jlpExtraArgs" type="text" class="mono" placeholder="-d 18 -ws -w /data/kang.work -wi 300" bind:value={kangJlpExtra} />
        </label>
      </div>
    {:else if kangMode === 'remote-gpu'}
      <div class="rpc-grid kang-panel">
        <p class="faint small full kang-hint">
          Uses <span class="mono">{data.kangaroo.defaults.wrapperPath}</span> over SSH.
          Passwordless key auth required. Guide: <span class="mono">docs/KANGAROO-GPU.md</span>.
        </p>
        <label class="full">
          <span>SSH host <em class="faint">(required — user@gpu-box)</em></span>
          <input name="sshHost" type="text" class="mono" placeholder="adam@gpu-3090" bind:value={kangSshHost} autocomplete="off" />
        </label>
        <label class="full">
          <span>Remote kangaroo binary</span>
          <input name="remoteBin" type="text" class="mono" placeholder={data.kangaroo.defaults.remoteBin} bind:value={kangRemoteBin} />
        </label>
        <label>
          <span>GPU id(s) on remote</span>
          <input name="jlpGpuId" type="text" class="mono" placeholder="0" bind:value={kangJlpGpuId} />
        </label>
        <label class="full">
          <span>SSH options <em class="faint">(optional)</em></span>
          <input name="sshOpts" type="text" class="mono" placeholder="-o BatchMode=yes -i ~/.ssh/id_ed25519_gpu" bind:value={kangSshOpts} />
        </label>
        <label class="full">
          <span>Extra remote args</span>
          <input name="jlpExtraArgs" type="text" class="mono" placeholder="-d 18 -ws -w /data/kang.work -wi 300" bind:value={kangJlpExtra} />
        </label>
        <label class="full">
          <span>Local SSH wrapper path</span>
          <input name="wrapperPath" type="text" class="mono" placeholder={data.kangaroo.defaults.wrapperPath} bind:value={kangWrapper} />
        </label>
        <!-- keep jlpUseGpu on for remote (wrapper always passes -gpu) -->
        <input type="hidden" name="jlpUseGpu" value="on" />
      </div>
    {:else if kangMode === 'custom'}
      <div class="rpc-grid kang-panel">
        <label class="full">
          <span>Command template <em class="faint">({'{pubkey} {lo} {hi} {lo64} {hi64} {threads} {puzzle}'})</em></span>
          <input
            name="externalCmd"
            type="text"
            class="mono"
            placeholder={'./scripts/my-wrapper.sh {pubkey} {lo} {hi}'}
            bind:value={kangExternal}
          />
        </label>
        <p class="faint small full">
          Process must emit JSONL: progress / found / exhausted / cancelled / error.
          Demo: <span class="mono">scripts/kangaroo-external-echo.sh</span>.
        </p>
      </div>
    {:else}
      <p class="faint small kang-panel">
        Uses <span class="mono">satoshi-kangaroo</span> on this machine
        (<span class="mono">npm run grind:build</span>). No GPU config needed.
      </p>
      <!-- preserve remote fields when switching modes so they are not wiped -->
      <input type="hidden" name="sshHost" value={kangSshHost} />
      <input type="hidden" name="sshOpts" value={kangSshOpts} />
      <input type="hidden" name="remoteBin" value={kangRemoteBin} />
      <input type="hidden" name="wrapperPath" value={kangWrapper} />
      <input type="hidden" name="jlpBin" value={kangJlpBin} />
      <input type="hidden" name="jlpExtraArgs" value={kangJlpExtra} />
      <input type="hidden" name="jlpGpuId" value={kangJlpGpuId} />
      <input type="hidden" name="externalCmd" value={kangExternal} />
    {/if}

    {#if kangMode === 'local-gpu' || kangMode === 'remote-gpu'}
      <!-- preserve fields not shown in the other GPU panel -->
      {#if kangMode === 'local-gpu'}
        <input type="hidden" name="sshHost" value={kangSshHost} />
        <input type="hidden" name="sshOpts" value={kangSshOpts} />
        <input type="hidden" name="remoteBin" value={kangRemoteBin} />
        <input type="hidden" name="wrapperPath" value={kangWrapper} />
        <input type="hidden" name="externalCmd" value={kangExternal} />
      {:else}
        <input type="hidden" name="jlpBin" value={kangJlpBin} />
        <input type="hidden" name="externalCmd" value="" />
      {/if}
    {:else if kangMode === 'custom'}
      <input type="hidden" name="sshHost" value={kangSshHost} />
      <input type="hidden" name="sshOpts" value={kangSshOpts} />
      <input type="hidden" name="remoteBin" value={kangRemoteBin} />
      <input type="hidden" name="wrapperPath" value={kangWrapper} />
      <input type="hidden" name="jlpBin" value={kangJlpBin} />
      <input type="hidden" name="jlpExtraArgs" value={kangJlpExtra} />
      <input type="hidden" name="jlpGpuId" value={kangJlpGpuId} />
    {/if}

    <p class="faint small">
      Stock JeanLucPons ≈ 125-bit interval limit. Switching mode here
      <b>enables</b> that runner for the next kangaroo start (Grinder UI or
      <span class="mono">npm run kangaroo</span>).
    </p>
    <div class="actions">
      <button type="submit" disabled={!!busy}>
        {busy === 'save-kangaroo' ? 'Saving…' : 'Save & enable runner'}
      </button>
    </div>
  </form>

  {#if kangMode === 'remote-gpu'}
    <form
      method="POST"
      action="?/testKangarooRemote"
      class="rpc-form kang-test"
      use:enhance={track('test-kangaroo-remote')}
    >
      <input type="hidden" name="sshHost" value={kangSshHost} />
      <input type="hidden" name="sshOpts" value={kangSshOpts} />
      <input type="hidden" name="remoteBin" value={kangRemoteBin} />
      <div class="actions">
        <button type="submit" class="secondary" disabled={!!busy || !kangSshHost}>
          {busy === 'test-kangaroo-remote' ? 'Probing…' : 'Test SSH + GPU'}
        </button>
      </div>
      <p class="faint small">Runs <span class="mono">nvidia-smi -L</span> and <span class="mono">kangaroo -l</span> on the remote host (uses form values, even if not saved yet).</p>
    </form>
  {/if}
</div>

<div class="card">
  <div class="k">Richlist</div>
  <p class="faint small top-note">Source: <b>{data.richlist.source}</b></p>
  <form
    method="POST"
    action="?/saveRichlist"
    class="rpc-form"
    use:enhance={track('save-richlist')}
  >
    <label>
      <span>Minimum balance (sats) <em class="faint">≈ {richlistMinBtc} BTC</em></span>
      <input name="minSats" type="number" min="0" bind:value={richlistMinSats} />
    </label>
    <fieldset class="buckets">
      <legend>Script types kept in the match-set</legend>
      {#each SCRIPT_TYPES as t}
        <label class="bucket-item">
          <input type="checkbox" name="scriptPolicy" value={t} bind:group={richlistScriptPolicy} />
          {t}
        </label>
      {/each}
    </fieldset>
    <label>
      <span>Loyce daily dump URL</span>
      <input name="loyceUrl" type="url" value={data.richlist.loyceUrl} autocomplete="off" />
    </label>
    <div class="actions">
      <button type="submit" disabled={!!busy}>{busy === 'save-richlist' ? 'Saving…' : 'Save'}</button>
    </div>
  </form>
</div>

<div class="card">
  <div class="k">Vault (key encryption)</div>
  <p class="row">
    <span class="dot" class:ok={data.vault.configured} class:bad={!data.vault.configured}></span>
    <b class:ok={data.vault.configured} class:bad={!data.vault.configured}
      >{data.vault.configured ? 'configured' : 'not configured'}</b
    >
    {#if data.vault.configured}· source: {data.vault.source}{/if}
  </p>
  {#if data.vault.configured}
    <p class="faint small">
      A vault key is set. It cannot be viewed or rotated from this UI — rotating it would make
      already-encrypted recovered keys permanently undecryptable.
    </p>
  {:else}
    <form
      method="POST"
      action="?/generateVaultKey"
      use:enhance={track('gen-vault')}
    >
      <button type="submit" disabled={!!busy}>
        {busy === 'gen-vault' ? 'Generating…' : 'Generate vault key'}
      </button>
    </form>
  {/if}
</div>

<style>
  h1 {
    margin-bottom: 4px;
  }
  .muted {
    margin-top: 0;
    margin-bottom: 18px;
  }
  .card {
    margin-bottom: 14px;
  }
  .k {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent-soft);
    margin-bottom: 10px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    flex-wrap: wrap;
    overflow-wrap: anywhere;
  }
  .row .mono {
    word-break: break-all;
  }
  .probe {
    margin-bottom: 12px;
    padding: 8px 10px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.03);
  }
  .probe.ok {
    color: var(--success);
  }
  .probe.bad {
    color: var(--danger);
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--text-faint);
    flex-shrink: 0;
  }
  .dot.ok {
    background: var(--success);
  }
  .dot.bad {
    background: var(--danger);
  }
  .ok {
    color: var(--success);
  }
  .ok-text {
    color: var(--success);
  }
  .bad {
    color: var(--danger);
  }
  .kang-panel {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }
  .kang-hint {
    margin: 0 0 8px;
  }
  .kang-test {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px dashed rgba(255, 255, 255, 0.08);
  }
  .rpc-grid .full {
    grid-column: 1 / -1;
  }
  button.secondary {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }
  button.secondary:hover:not(:disabled) {
    border-color: var(--accent-soft);
  }
  .toast {
    white-space: pre-wrap;
  }
  .r {
    text-align: right;
  }
  .cap {
    text-transform: capitalize;
  }
  td {
    padding: 5px 8px;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    flex-wrap: wrap;
  }
  .toast {
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    margin-bottom: 16px;
  }
  .ok-toast {
    background: rgba(123, 255, 160, 0.09);
    border: 1px solid rgba(123, 255, 160, 0.3);
  }
  .err-toast {
    background: rgba(255, 87, 87, 0.1);
    border: 1px solid rgba(255, 87, 87, 0.3);
    color: var(--danger);
  }
  .small {
    font-size: 12px;
    margin-top: 10px;
  }
  .top-note {
    margin-top: 0;
    margin-bottom: 12px;
  }
  .pace-set {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 10px 12px;
    margin: 0 0 12px;
  }
  .pace-set legend {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent-soft);
    padding: 0 4px;
  }
  .pace-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 8px 0;
    cursor: pointer;
  }
  .pace-item input {
    margin-top: 3px;
    width: auto;
  }
  .pace-item b {
    display: block;
  }
  .pace-item em {
    display: block;
    font-style: normal;
    font-size: 12px;
  }
  .rpc-form label {
    display: block;
    margin-bottom: 10px;
  }
  .rpc-form label span {
    display: block;
    font-size: 12px;
    color: var(--accent-soft);
    margin-bottom: 4px;
  }
  .rpc-form input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(0, 0, 0, 0.25);
    color: inherit;
    font-family: inherit;
    font-size: 13px;
  }
  .rpc-form input:focus,
  .rpc-form textarea:focus {
    outline: 1px solid var(--accent-soft);
  }
  .rpc-form textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(0, 0, 0, 0.25);
    color: inherit;
    font-family: inherit;
    font-size: 13px;
    resize: vertical;
  }
  .rpc-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .confirm {
    display: flex !important;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .buckets {
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    padding: 10px 12px;
    margin: 0 0 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px 16px;
  }
  .buckets legend {
    font-size: 12px;
    color: var(--accent-soft);
    padding: 0 4px;
  }
  .bucket-item {
    display: flex !important;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    text-transform: capitalize;
    margin: 0 !important;
  }
  .danger-note {
    color: var(--danger);
    font-size: 13px;
    margin: 8px 0;
  }
  .wallet-reveal {
    border: 1px solid rgba(255, 87, 87, 0.35);
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 14px;
    background: rgba(255, 87, 87, 0.06);
  }
  .mnemonic {
    background: rgba(0, 0, 0, 0.3);
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 14px;
    line-height: 1.6;
    word-spacing: 6px;
    margin: 8px 0;
  }
  button.secondary {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }
  button.danger {
    border-color: rgba(255, 87, 87, 0.4);
    color: var(--danger);
  }
  @media (max-width: 820px) {
    .rpc-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
