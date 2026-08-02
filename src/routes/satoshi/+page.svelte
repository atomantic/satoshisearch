<script lang="ts">
  import type { PageData, ActionData } from './$types';
  import { enhance } from '$app/forms';
  import { btcShort, shortAddr, timeAgo } from '$lib/format';

  export let data: PageData;
  export let form: ActionData;

  let rechecking = false;
  $: a = data.agg;
</script>

<svelte:head><title>Satoshi Watch · satoshisearch</title></svelte:head>

<div class="head">
  <div>
    <h1>Satoshi Watch</h1>
    <p class="muted">
      The early block-reward coins — Satoshi-era P2PK outputs holding an untouched 50 BTC. Balances
      are read by <em>script hash</em>, the only way to see P2PK value correctly. The day one of
      these moves is the day a legend stirs.
    </p>
  </div>
  <form
    method="POST"
    action="?/recheck"
    use:enhance={() => {
      rechecking = true;
      return async ({ update }) => {
        await update({ reset: false });
        rechecking = false;
      };
    }}
  >
    <button class="btn-accent" disabled={rechecking}>{rechecking ? 'Re-checking…' : 'Re-check funded'}</button>
  </form>
</div>

{#if form?.swept}
  <div class="toast">
    Re-checked {form.swept} funded targets in {(form.elapsedMs / 1000).toFixed(1)}s ·
    {form.moved} moved{form.moved ? ' ⚠' : ' — all still dormant 😴'}
  </div>
{/if}

{#if a.total === 0}
  <div class="card">
    <p>No coinbase set indexed yet. Build it with:</p>
    <pre class="mono">npm run index:coinbase</pre>
    <p class="faint small">
      Walks early blocks on your node and records each coinbase scriptPubKey. ~12 min for 50,000
      blocks; resumable.
    </p>
  </div>
{:else}
  <div class="stats">
    <div class="card stat">
      <div class="k">Still untouched</div>
      <div class="v btc">{btcShort(a.sats)}</div>
      <div class="sub faint">BTC across {a.funded?.toLocaleString()} dormant outputs</div>
    </div>
    <div class="card stat">
      <div class="k">Outputs watched</div>
      <div class="v">{a.total.toLocaleString()}</div>
      <div class="sub faint">early coinbase rewards · to block {data.indexedMaxHeight.toLocaleString()}</div>
    </div>
    <div class="card stat">
      <div class="k">Dormant ratio</div>
      <div class="v">{a.total ? Math.round((a.funded / a.total) * 100) : 0}<span class="u">%</span></div>
      <div class="sub faint">of early rewards never spent</div>
    </div>
    <div class="card stat">
      <div class="k">Last checked</div>
      <div class="v small-v">{timeAgo(a.lastChecked)}</div>
      <div class="sub faint">balances via your node</div>
    </div>
  </div>

  {#if data.moves.length}
    <div class="card alert-card">
      <div class="k danger-k">⚠ Dormant coins that moved</div>
      <table>
        <thead><tr><th>Address</th><th>Block</th><th class="r">Was</th><th class="r">Now</th><th class="r">When</th></tr></thead>
        <tbody>
          {#each data.moves as m}
            <tr>
              <td class="mono"><a href={m.link} target="_blank" rel="noreferrer">{shortAddr(m.address)}</a></td>
              <td class="num faint">{m.height?.toLocaleString()}</td>
              <td class="num r">{btcShort(m.old)}</td>
              <td class="num r danger">{btcShort(m.new)}</td>
              <td class="num r faint">{timeAgo(m.ts)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="card">
    <div class="k">Earliest untouched rewards</div>
    <p class="faint small">The oldest coinbase outputs still holding their full 50 BTC.</p>
    <table>
      <thead><tr><th>Block</th><th>Address</th><th>Type</th><th class="r">Balance</th></tr></thead>
      <tbody>
        {#each data.topFunded as t}
          <tr>
            <td class="num faint">{t.height?.toLocaleString()}</td>
            <td class="mono"><a href={t.link} target="_blank" rel="noreferrer">{shortAddr(t.address)}</a></td>
            <td><span class="badge sealed">{t.type}</span></td>
            <td class="num r btc">{btcShort(t.bal)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 24px;
    margin-bottom: 20px;
  }
  .head p {
    max-width: 720px;
    margin: 6px 0 0;
  }
  .toast {
    background: rgba(123, 255, 160, 0.09);
    border: 1px solid rgba(123, 255, 160, 0.3);
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    margin-bottom: 16px;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin-bottom: 20px;
  }
  .stat .k {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent-soft);
  }
  .stat .v {
    font-size: 28px;
    font-weight: 700;
    margin-top: 4px;
    line-height: 1.05;
  }
  .stat .v.small-v {
    font-size: 20px;
  }
  .stat .v .u {
    font-size: 14px;
    color: var(--text-faint);
    margin-left: 3px;
  }
  .stat .sub {
    font-size: 12px;
    margin-top: 6px;
  }
  .k {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent-soft);
    margin-bottom: 6px;
  }
  .danger-k {
    color: var(--danger);
  }
  .alert-card {
    border-color: rgba(255, 87, 87, 0.3);
    margin-bottom: 16px;
  }
  .r {
    text-align: right;
  }
  .small {
    font-size: 12px;
    margin: 0 0 8px;
  }
  pre {
    background: var(--bg);
    padding: 10px 14px;
    border-radius: 6px;
    display: inline-block;
  }
  @media (max-width: 820px) {
    .stats {
      grid-template-columns: repeat(2, 1fr);
    }
    .head {
      flex-direction: column;
    }
  }
</style>
