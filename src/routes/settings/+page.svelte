<script lang="ts">
  import type { PageData, ActionData } from './$types';
  import { enhance } from '$app/forms';
  import { timeAgo } from '$lib/format';
  export let data: PageData;
  export let form: ActionData;
  const c = data.config;
  let busy = '';
</script>

<svelte:head><title>Settings · satoshisearch</title></svelte:head>

<h1>Settings</h1>
<p class="muted">Configuration is read from the environment (see <code>.env.example</code>). In Umbrel these come from the app's compose file.</p>

{#if form?.done}<div class="toast">{form.done}</div>{/if}

<div class="card">
  <div class="k">Node</div>
  <div class="row">
    <span class="dot" class:ok={data.node.ok} class:bad={!data.node.ok}></span>
    {#if data.node.ok}
      Connected to <span class="mono">{c.mempoolApiUrl}</span> · tip <b class="num">{data.node.tip?.toLocaleString()}</b>
      · {data.node.fastestFee ?? '—'} sat/vB · {data.isLocal ? 'local node (private)' : 'public mempool.space'}
    {:else}
      <span class="bad">Unreachable at {c.mempoolApiUrl}</span> — set <code>MEMPOOL_API_URL</code>.
    {/if}
  </div>
</div>

<div class="two">
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
      <form method="POST" action="?/indexPuzzles" use:enhance={() => { busy='puzzles'; return async ({update}) => { await update(); busy=''; }; }}>
        <button disabled={!!busy}>{busy==='puzzles' ? 'Indexing…' : 'Re-index puzzles'}</button>
      </form>
      <form method="POST" action="?/recheckFunded" use:enhance={() => { busy='funded'; return async ({update}) => { await update(); busy=''; }; }}>
        <button disabled={!!busy}>{busy==='funded' ? 'Checking…' : 'Re-check funded'}</button>
      </form>
    </div>
    <p class="faint small">Large indexing jobs (coinbase, richlist) run from the CLI — see README.</p>
  </div>

  <div class="card">
    <div class="k">Rescue policy</div>
    <table>
      <tbody>
        <tr><td>Broadcast</td><td class="r"><b class:bad={!c.dryRun}>{c.dryRun ? 'dry-run (safe)' : 'LIVE'}</b></td></tr>
        <tr><td>Destination</td><td class="r mono">{c.dest || 'none'}</td></tr>
        <tr><td>Auto-sweep buckets</td><td class="r">{c.autoBuckets.join(', ') || 'none'}</td></tr>
        <tr><td>White-hat attested</td><td class="r">{c.whitehatAttested ? 'yes' : 'no'}</td></tr>
        <tr><td>Dust floor</td><td class="r num">{c.dustSats.toLocaleString()} sats</td></tr>
        <tr><td>Vault (key encryption)</td><td class="r"><b class:ok={c.vaultReady} class:bad={!c.vaultReady}>{c.vaultReady ? 'ready' : 'unset'}</b></td></tr>
      </tbody>
    </table>
    <p class="faint small">These are set via env vars (<code>SWEEP_*</code>, <code>RESCUE_*</code>, <code>VAULT_KEY_HEX</code>) and require a restart to change.</p>
  </div>
</div>

<div class="card">
  <div class="k">Runtime</div>
  <table>
    <tbody>
      <tr><td>Mempool API</td><td class="r mono">{c.mempoolApiUrl}</td></tr>
      <tr><td>Request concurrency</td><td class="r num">{c.concurrency}</td></tr>
      <tr><td>Coinbase max height</td><td class="r num">{c.coinbaseMaxHeight.toLocaleString()}</td></tr>
      <tr><td>Data dir</td><td class="r mono">{c.dataDir}</td></tr>
    </tbody>
  </table>
</div>

<style>
  h1 { margin-bottom: 4px; }
  .muted { margin-top: 0; margin-bottom: 18px; }
  .card { margin-bottom: 14px; }
  .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-soft); margin-bottom: 10px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .row { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; overflow-wrap: anywhere; }
  .row .mono { word-break: break-all; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-faint); }
  .dot.ok { background: var(--success); }
  .dot.bad { background: var(--danger); }
  .ok { color: var(--success); }
  .bad { color: var(--danger); }
  .r { text-align: right; }
  .cap { text-transform: capitalize; }
  td { padding: 5px 8px; }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
  .toast { background: rgba(123,255,160,0.09); border: 1px solid rgba(123,255,160,0.3); border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 16px; }
  .small { font-size: 12px; margin-top: 10px; }
  @media (max-width: 820px) { .two { grid-template-columns: 1fr; } }
</style>
