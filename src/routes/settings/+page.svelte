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

  /**
   * Remote-GPU probe. The SSH round-trip can take up to 20s, so this reports
   * in place next to the row's button — a result rendered only in the page-top
   * toast reads as "nothing happened" from this far down the page.
   */
  let kangTestResult: { id: string; ok: boolean; text: string } | null = null;
  const testKey = (id: string) => `test-kang-${id}`;

  const testRunner =
    (id: string): SubmitFunction =>
    () => {
      busy = testKey(id);
      kangTestResult = null;
      return async ({ result }) => {
        busy = '';
        if (result.type === 'success') {
          kangTestResult = { id, ok: true, text: String(result.data?.done ?? 'Probe OK.') };
        } else if (result.type === 'failure') {
          kangTestResult = { id, ok: false, text: String(result.data?.error ?? 'Probe failed.') };
        } else if (result.type === 'error') {
          kangTestResult = { id, ok: false, text: result.error?.message ?? 'Request failed.' };
        }
        // Deliberately no update() — the inline row is the report, and a
        // reload would only replace the fresh probe with load-time status.
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

  // Kangaroo multi-runner editor
  let editId = '';
  let editName = '';
  let editKind: 'cpu' | 'local-gpu' | 'remote-gpu' | 'custom' = 'remote-gpu';
  let editEnabled = true;
  let editJlpBin = '';
  let editJlpExtra = '';
  let editJlpGpuId = '0';
  let editJlpUseGpu = true;
  let editExternal = '';
  let editSshHost = '';
  let editSshOpts = '';
  let editRemoteBin = data.kangaroo.defaults.remoteBin;
  let editWrapper = data.kangaroo.defaults.wrapperPath;
  let showEditor = false;

  function startAdd(kind: typeof editKind = 'remote-gpu') {
    editId = '';
    editName = kind === 'remote-gpu' ? 'GPU remote' : kind === 'cpu' ? 'CPU (this machine)' : kind === 'local-gpu' ? 'Local CUDA' : 'Custom';
    editKind = kind;
    editEnabled = true;
    editJlpBin = '';
    editJlpExtra = '';
    editJlpGpuId = '0';
    editJlpUseGpu = true;
    editExternal = '';
    editSshHost = '';
    editSshOpts = '-o BatchMode=yes';
    editRemoteBin = data.kangaroo.defaults.remoteBin;
    editWrapper = data.kangaroo.defaults.wrapperPath;
    showEditor = true;
  }

  function startEdit(r: (typeof data.kangaroo.runners)[0]) {
    editId = r.id;
    editName = r.name;
    editKind = r.kind as typeof editKind;
    editEnabled = r.enabled;
    editJlpBin = r.jlpBin;
    editJlpExtra = r.jlpExtraArgs;
    editJlpGpuId = r.jlpGpuId || '0';
    editJlpUseGpu = r.jlpUseGpuResolved;
    editExternal = r.externalCmd;
    editSshHost = r.sshHost;
    editSshOpts = r.sshOpts;
    editRemoteBin = r.remoteBin || data.kangaroo.defaults.remoteBin;
    editWrapper = r.wrapperPath || data.kangaroo.defaults.wrapperPath;
    showEditor = true;
  }
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
  <div class="k">Kangaroo runners (CPU + multi GPU)</div>
  <p class="faint small top-note">
    Race one or more solvers on the same puzzle (first find wins).
    Source: <b>{data.kangaroo.source}</b> ·
    {data.kangaroo.availableCount}/{data.kangaroo.runners.length} ready ·
    {data.kangaroo.enabledCount} enabled ·
    {#if data.kangaroo.available}<span class="ok-text">ready</span>{:else}<span class="warn">not ready</span>{/if}
  </p>

  <table class="kang-table">
    <thead>
      <tr>
        <th>On</th>
        <th>Name</th>
        <th>Kind</th>
        <th>Target</th>
        <th>Status</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each data.kangaroo.runners as r}
        <tr class:dim={!r.enabled}>
          <td>
            <form method="POST" action="?/toggleKangarooRunner" use:enhance={track('tog-kang')}>
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="enabled" value={r.enabled ? 'false' : 'true'} />
              <button type="submit" class="linkish" title={r.enabled ? 'Disable' : 'Enable'}>
                {r.enabled ? '✓' : '–'}
              </button>
            </form>
          </td>
          <td><b>{r.name}</b></td>
          <td class="mono faint">{r.kind}</td>
          <td class="mono small">
            {#if r.kind === 'remote-gpu'}{r.sshHost || '—'}
            {:else if r.kind === 'local-gpu'}{r.jlpBin || '—'}
            {:else if r.kind === 'custom'}{r.externalCmd.slice(0, 40) || '—'}
            {:else}local CPU{/if}
          </td>
          <td class="small">
            {#if r.available}<span class="ok-text">ready</span>{:else}<span class="warn">not ready</span>{/if}
            <span class="faint"> · {r.detail}</span>
          </td>
          <td class="r actions-cell">
            <button type="button" class="linkish" on:click={() => startEdit(r)}>Edit</button>
            {#if r.kind === 'remote-gpu' && r.sshHost}
              <form method="POST" action="?/testKangarooRemote" use:enhance={testRunner(r.id)} class="inline">
                <input type="hidden" name="sshHost" value={r.sshHost} />
                <input type="hidden" name="sshOpts" value={r.sshOpts} />
                <input type="hidden" name="remoteBin" value={r.remoteBinResolved} />
                <button type="submit" class="linkish" disabled={!!busy}>
                  {busy === testKey(r.id) ? 'Testing…' : 'Test'}
                </button>
              </form>
            {/if}
            <form method="POST" action="?/deleteKangarooRunner" use:enhance={track('del-kang')} class="inline">
              <input type="hidden" name="id" value={r.id} />
              <button type="submit" class="linkish danger-link">Remove</button>
            </form>
          </td>
        </tr>
        {#if busy === testKey(r.id)}
          <tr class="probe-row">
            <td colspan="6">
              <div class="kang-probe faint">Probing {r.sshHost} over SSH — up to 20s…</div>
            </td>
          </tr>
        {:else if kangTestResult?.id === r.id}
          <tr class="probe-row">
            <td colspan="6">
              <div class="kang-probe" class:ok={kangTestResult.ok} class:bad={!kangTestResult.ok}>
                {kangTestResult.text}
              </div>
              <button type="button" class="linkish" on:click={() => (kangTestResult = null)}>
                Dismiss
              </button>
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>

  <div class="actions" style="margin-top: 10px; gap: 8px; flex-wrap: wrap;">
    <button type="button" class="secondary" on:click={() => startAdd('remote-gpu')}>+ Remote GPU</button>
    <button type="button" class="secondary" on:click={() => startAdd('cpu')}>+ CPU</button>
    <button type="button" class="secondary" on:click={() => startAdd('local-gpu')}>+ Local CUDA</button>
    <button type="button" class="secondary" on:click={() => startAdd('custom')}>+ Custom</button>
  </div>

  {#if showEditor}
    <form
      method="POST"
      action="?/saveKangarooRunner"
      class="rpc-form kang-panel"
      use:enhance={track('save-kang-runner')}
    >
      <input type="hidden" name="id" value={editId} />
      <h3 class="kang-edit-title">{editId ? 'Edit runner' : 'Add runner'}</h3>
      <div class="rpc-grid">
        <label>
          <span>Name</span>
          <input name="name" type="text" bind:value={editName} required />
        </label>
        <label>
          <span>Kind</span>
          <select name="kind" bind:value={editKind}>
            <option value="cpu">CPU (this machine)</option>
            <option value="local-gpu">Local CUDA</option>
            <option value="remote-gpu">Remote GPU (SSH)</option>
            <option value="custom">Custom JSONL command</option>
          </select>
        </label>
        <label class="check full">
          <input type="checkbox" name="enabled" bind:checked={editEnabled} />
          <span>Enabled for multi-runner races (Grinder default)</span>
        </label>

        {#if editKind === 'remote-gpu'}
          <label class="full">
            <span>SSH host <em class="faint">user@100.x.x.x</em></span>
            <input name="sshHost" type="text" class="mono" bind:value={editSshHost} placeholder="user@100.120.88.104" autocomplete="off" />
          </label>
          <label class="full">
            <span>Remote binary</span>
            <input name="remoteBin" type="text" class="mono" bind:value={editRemoteBin} />
          </label>
          <label>
            <span>GPU id</span>
            <input name="jlpGpuId" type="text" class="mono" bind:value={editJlpGpuId} />
          </label>
          <label class="full">
            <span>SSH options</span>
            <input name="sshOpts" type="text" class="mono" bind:value={editSshOpts} />
          </label>
          <label class="full">
            <span>Extra remote args</span>
            <input name="jlpExtraArgs" type="text" class="mono" bind:value={editJlpExtra} placeholder="-d 18 -ws -w /data/kang.work -wi 300" />
          </label>
          <label class="full">
            <span>Local wrapper</span>
            <input name="wrapperPath" type="text" class="mono" bind:value={editWrapper} />
          </label>
          <input type="hidden" name="jlpUseGpu" value="on" />
        {:else if editKind === 'local-gpu'}
          <label class="full">
            <span>JLP binary path</span>
            <input name="jlpBin" type="text" class="mono" bind:value={editJlpBin} placeholder="/opt/Kangaroo/kangaroo" />
          </label>
          <label>
            <span>GPU id</span>
            <input name="jlpGpuId" type="text" class="mono" bind:value={editJlpGpuId} />
          </label>
          <label class="check">
            <input type="checkbox" name="jlpUseGpu" bind:checked={editJlpUseGpu} />
            <span>-gpu</span>
          </label>
          <label class="full">
            <span>Extra args</span>
            <input name="jlpExtraArgs" type="text" class="mono" bind:value={editJlpExtra} />
          </label>
        {:else if editKind === 'custom'}
          <label class="full">
            <span>Command template</span>
            <input name="externalCmd" type="text" class="mono" bind:value={editExternal} placeholder={'./wrapper.sh {pubkey} {lo} {hi}'} />
          </label>
        {/if}
      </div>
      <div class="actions">
        <button type="submit" disabled={!!busy}>
          {busy === 'save-kang-runner' ? 'Saving…' : 'Save runner'}
        </button>
        <button type="button" class="secondary" on:click={() => (showEditor = false)}>Cancel</button>
      </div>
      <p class="faint small">Guide: <span class="mono">docs/KANGAROO-GPU.md</span>. Enabled runners race together on Start kangaroo.</p>
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
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }
  .kang-table {
    width: 100%;
    font-size: 13px;
    border-collapse: collapse;
  }
  .kang-table th,
  .kang-table td {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    vertical-align: top;
  }
  .kang-table tr.dim {
    opacity: 0.55;
  }
  .kang-table tr.probe-row td {
    padding-top: 0;
  }
  .kang-probe {
    white-space: pre-wrap;
    font-family: var(--mono);
    font-size: 12px;
    border-radius: 6px;
    padding: 8px 10px;
    margin: 2px 0 6px;
    max-height: 220px;
    overflow: auto;
    background: rgba(255, 255, 255, 0.03);
  }
  .kang-probe.ok {
    color: var(--success);
  }
  .kang-probe.bad {
    color: var(--danger);
  }
  .kang-table .small {
    font-size: 12px;
  }
  .actions-cell {
    white-space: nowrap;
  }
  .actions-cell .inline {
    display: inline;
  }
  button.linkish {
    background: none;
    border: none;
    color: var(--accent-soft);
    cursor: pointer;
    padding: 0 6px;
    font: inherit;
  }
  button.linkish.danger-link {
    color: var(--danger);
  }
  .kang-edit-title {
    margin: 0 0 10px;
    font-size: 14px;
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
    /* This page is long enough that a static toast reports into empty space for
       any form below the fold. Sticking it under the 58px layout header keeps
       every action's result visible from wherever it was triggered. */
    position: sticky;
    top: 58px;
    z-index: 9;
    /* Opaque base so the pinned toast stays legible over scrolling content;
       the ok/err tints layer on top as a background-image. */
    background: rgba(26, 16, 64, 0.94);
    backdrop-filter: blur(10px);
  }
  .ok-toast {
    background-image: linear-gradient(rgba(123, 255, 160, 0.09), rgba(123, 255, 160, 0.09));
    border: 1px solid rgba(123, 255, 160, 0.3);
  }
  .err-toast {
    background-image: linear-gradient(rgba(255, 87, 87, 0.1), rgba(255, 87, 87, 0.1));
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
