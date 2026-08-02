<script lang="ts">
  import type { PageData, ActionData } from './$types';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { bigCount } from '$lib/format';

  export let data: PageData;
  export let form: ActionData;

  let selected = data.sources.find((s) => s.available)?.id ?? '';

  // Poll status while a grind is running so keys/sec updates live.
  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    timer = setInterval(() => {
      if (data.status.running) invalidateAll();
    }, 1500);
  });
  onDestroy(() => clearInterval(timer));

  $: st = data.status;
  $: matchN = data.matchSet.size;
</script>

<svelte:head><title>Grinder · satoshisearch</title></svelte:head>

<div class="head">
  <h1>Key Grinder</h1>
  <p class="muted">
    Generate candidate private keys from bounded weak-key classes and match them against
    {bigCount(matchN)} watched targets ({bigCount(data.matchSet.hash160s)} hash160 · {data.matchSet.pubkeys}
    P2PK pubkeys). Every candidate is checked as compressed <em>and</em> uncompressed — the bug that
    made the old tool unable to match Satoshi's keys.
  </p>
</div>

<div class="honest">
  <b>Honest math:</b> at ~10<sup>5</sup> keys/s across your cores, 2<sup>72</sup> alone is ~10<sup>8</sup>
  years. Unbounded grinding never succeeds. Value comes only from classes whose <em>effective</em>
  space is small — brainwallets, low-entropy, the ColdCard seed-state — plus the monitoring itself.
</div>

{#if form?.error}<div class="err">{form.error}</div>{/if}

<div class="grid">
  <div class="card status-card" class:live={st.running}>
    <div class="k">Status</div>
    {#if st.running}
      <div class="v"><span class="pulse"></span>Running · {st.sourceName}</div>
      <div class="metrics">
        <div><span class="faint">keys/sec</span><b class="num">{st.keysPerSec.toLocaleString()}</b></div>
        <div><span class="faint">tried</span><b class="num">{bigCount(st.keysTried)}</b></div>
        <div><span class="faint">workers</span><b class="num">{st.workers}</b></div>
        <div><span class="faint">hits</span><b class="num" class:btc={st.hits > 0}>{st.hits}</b></div>
      </div>
      <form method="POST" action="?/stop" use:enhance>
        <button class="stop">Stop</button>
      </form>
    {:else}
      <div class="v faint">Idle</div>
      <form
        method="POST"
        action="?/start"
        use:enhance={() => async ({ update }) => { await update(); }}
      >
        <label class="sel">
          <span class="faint">Source</span>
          <select name="source" bind:value={selected}>
            {#each data.sources as s}
              <option value={s.id} disabled={!s.available}>
                {s.label}{s.available ? '' : ' — ' + (s.note ?? 'unavailable')}
              </option>
            {/each}
          </select>
        </label>
        <button class="btn-accent">Start grind</button>
      </form>
    {/if}
  </div>

  <div class="card policy-card">
    <div class="k">Sweep policy</div>
    <ul class="policy">
      <li>
        <span class="dot" class:ok={data.policy.dryRun} class:warn={!data.policy.dryRun}></span>
        {data.policy.dryRun ? 'Dry-run ON — signs but never broadcasts' : 'Dry-run OFF — will broadcast'}
      </li>
      <li>
        <span class="dot" class:ok={data.policy.destConfigured} class:warn={!data.policy.destConfigured}></span>
        {data.policy.destConfigured ? 'Rescue destination set' : 'No rescue destination (fail-safe hold)'}
      </li>
      <li>
        <span class="dot ok"></span>
        Auto-sweep: {data.policy.autoBuckets.join(', ') || 'none'}
      </li>
      <li>
        <span class="dot" class:ok={data.policy.whitehatAttested} class:faint-dot={!data.policy.whitehatAttested}></span>
        White-hat attestation {data.policy.whitehatAttested ? 'signed' : 'not signed (non-puzzle sweeps held)'}
      </li>
      <li>
        <span class="dot" class:ok={data.vaultReady} class:warn={!data.vaultReady}></span>
        Vault {data.vaultReady ? 'ready (keys encrypted at rest)' : 'NOT configured — hits recorded but keys unstored'}
      </li>
    </ul>
    <a href="/settings" class="faint small">Configure in Settings →</a>
  </div>
</div>

<div class="card">
  <div class="k">Candidate sources</div>
  <table>
    <thead><tr><th>Source</th><th>Bucket</th><th class="r">Space</th><th>What it is</th></tr></thead>
    <tbody>
      {#each data.sources as s}
        <tr class:disabled={!s.available}>
          <td>{s.label}</td>
          <td><span class="badge {s.bucket === 'puzzle' ? 'solved' : 'sealed'}">{s.bucket}</span></td>
          <td class="num r">2<sup>{s.spaceBits.toFixed(0)}</sup></td>
          <td class="faint small">{s.description}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .head {
    margin-bottom: 14px;
  }
  .head p {
    max-width: 780px;
    margin: 6px 0 0;
  }
  .honest {
    background: rgba(77, 244, 255, 0.06);
    border: 1px solid rgba(77, 244, 255, 0.2);
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    margin-bottom: 16px;
  }
  .err {
    background: rgba(255, 87, 87, 0.1);
    border: 1px solid rgba(255, 87, 87, 0.3);
    color: var(--danger);
    padding: 10px 14px;
    border-radius: 8px;
    margin-bottom: 14px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1.1fr 1fr;
    gap: 14px;
    margin-bottom: 16px;
  }
  .k {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent-soft);
    margin-bottom: 8px;
  }
  .status-card .v {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status-card.live {
    border-color: rgba(123, 255, 160, 0.4);
  }
  .pulse {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 0 0 var(--glow-success);
    animation: pulse 1.4s infinite;
  }
  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(123, 255, 160, 0.5);
    }
    70% {
      box-shadow: 0 0 0 10px rgba(123, 255, 160, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(123, 255, 160, 0);
    }
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 14px;
  }
  .metrics div {
    display: flex;
    flex-direction: column;
  }
  .metrics .faint {
    font-size: 11px;
    text-transform: uppercase;
  }
  .metrics b {
    font-size: 20px;
  }
  .sel {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }
  .sel .faint {
    font-size: 11px;
    text-transform: uppercase;
  }
  select {
    font-family: var(--mono);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 8px 10px;
    font-size: 13px;
  }
  .stop {
    background: rgba(255, 87, 87, 0.15);
    border-color: rgba(255, 87, 87, 0.4);
    color: var(--danger);
  }
  .policy {
    list-style: none;
    padding: 0;
    margin: 0 0 10px;
    font-size: 13px;
  }
  .policy li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-faint);
    flex: none;
  }
  .dot.ok {
    background: var(--success);
  }
  .dot.warn {
    background: var(--warning);
  }
  .dot.faint-dot {
    background: var(--text-faint);
  }
  .r {
    text-align: right;
  }
  .small {
    font-size: 12px;
  }
  tr.disabled {
    opacity: 0.5;
  }
  @media (max-width: 820px) {
    .grid {
      grid-template-columns: 1fr;
    }
    .metrics {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
