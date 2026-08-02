<script lang="ts">
  import type { PageData, ActionData } from './$types';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { bigCount, btcShort, shortAddr } from '$lib/format';

  export let data: PageData;
  export let form: ActionData;

  let selected = data.sources.find((s) => s.available)?.id ?? '';

  // Poll status while a grind or kangaroo is running so rates update live.
  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    timer = setInterval(() => {
      if (data.status.running || data.kangaroo.running) invalidateAll();
    }, 1500);
  });
  onDestroy(() => clearInterval(timer));

  $: st = data.status;
  $: kg = data.kangaroo;
  $: matchN = data.matchSet.size;
  $: snap = data.richlistSnapshot;
  $: snapAgeH = snap ? Math.round((Date.now() / 1000 - snap.createdAt) / 3600) : null;
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
  {#if snap}
    <p class="muted small">
      Richlist snapshot: <span class="mono">{snap.source}</span>
      · {bigCount(snap.rowCount ?? 0)} rows
      · min {(snap.minSats / 1e8).toFixed(snap.minSats % 1e8 === 0 ? 0 : 2)} BTC
      · policy <span class="mono">{snap.scriptPolicy}</span>
      · age {snapAgeH}h
      {#if snapAgeH !== null && snapAgeH > 36}<span class="warn"> (stale — re-run richlist:refresh)</span>{/if}
    </p>
  {:else}
    <p class="muted small">
      No richlist snapshot yet. Run
      <span class="mono">npm run richlist:refresh</span>
      (or <span class="mono">index:richlist</span> on a TSV) to load a balance-aware single-key set.
    </p>
  {/if}
</div>

<div class="honest">
  <b>Honest math:</b> sequential ranges (puzzle N) and weak-RNG sources (ColdCard) are different.
  Puzzle work walks private-key integers. ColdCard walks <em>RNG seed states</em>, then BIP39→BIP32
  derives keys that are still scattered across 256-bit space — not concentrated in [1, 2<sup>72</sup>).
  Value comes from bounding the <em>effective work unit</em> (phrases, seed-state dims, small integers),
  not from raw secp throughput alone.
</div>

{#if form?.error}<div class="err">{form.error}</div>{/if}

<div class="grid">
  <div class="card status-card" class:live={st.running}>
    <div class="k">Status</div>
    {#if st.running}
      <div class="v"><span class="pulse"></span>Running · {st.sourceName}</div>
      <div class="metrics">
        {#if st.spaceKind === 'rng-states'}
          <div><span class="faint">states/sec</span><b class="num">{(st.seedsPerSec ?? 0).toLocaleString()}</b></div>
          <div><span class="faint">states tried</span><b class="num">{bigCount(st.seedsTried ?? 0)}</b></div>
          <div><span class="faint">keys checked</span><b class="num">{bigCount(st.keysTried)}</b></div>
        {:else}
          <div><span class="faint">keys/sec</span><b class="num">{st.keysPerSec.toLocaleString()}</b></div>
          <div><span class="faint">tried</span><b class="num">{bigCount(st.keysTried)}</b></div>
        {/if}
        <div><span class="faint">workers</span><b class="num">{st.workers}</b></div>
        <div><span class="faint">pace</span><b class="num mono">{st.pace ?? '—'}</b></div>
        <div><span class="faint">backend</span><b class="num mono">{st.backend ?? '—'}</b></div>
        <div><span class="faint">hits</span><b class="num" class:btc={st.hits > 0}>{st.hits}</b></div>
      </div>
      {#if st.pace === 'light'}
        <p class="faint small rng-note">
          Light pace — limited workers
          {#if st.throttleMs != null && st.throttleMs > 0}
            · {st.throttleMs}ms between batches
          {/if}
          · change in <a href="/settings">Settings → Grinder pace</a>.
        </p>
      {/if}
      {#if st.spaceKind === 'rng-states' && st.rngSpace}
        <p class="faint small rng-note">
          Work unit = RNG seed state (not a sequential key).
          {st.rngSpace.dimensions.map((d) => `${d.name}×${d.size}`).join(' · ')}
          = {st.spaceSize ?? st.rngSpace.seedStates.toString()} states
          × {st.rngSpace.keysPerSeed} HD keys/state.
          {#if st.rngSpace.isDemoSlice}
            <span class="warn"> Demo slice — pin uid/time for a real device.</span>
          {/if}
        </p>
      {/if}
      <form method="POST" action="?/stop" use:enhance>
        <button class="stop">Stop</button>
      </form>
    {:else}
      <div class="v faint">Idle</div>
      <p class="faint small rng-note">
        Pace: <b class="mono">{data.grind.pace}</b>
        · {data.grind.maxWorkers} workers
        · {data.grind.throttleMs}ms throttle
        · <a href="/settings">change</a>
      </p>
      <form method="POST" action="?/start" use:enhance>
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

<div class="card kang-card" class:live={kg.running}>
  <div class="k">Pollard's kangaroo · exposed puzzles</div>
  <p class="faint small kang-blurb">
    Interval ECDLP (~2<sup>n/2</sup> ops) for pubkey-known puzzles — not sequential grind.
    Backends: <span class="mono">cpu</span> (satoshi-kangaroo),
    <span class="mono">jlp</span> (JeanLucPons CUDA on your 3090),
    <span class="mono">external</span> (any JSONL solver). Configure via env or
    <a href="/settings">Settings</a>. #140 is still ~2<sup>69.5</sup> work.
  </p>
  <p class="faint small mono">
    mode: {kg.mode ?? kg.backend}
    {#if kg.sshHost}
      · {kg.sshHost}
    {/if}
    {#if kg.backendDetail}
      · {kg.backendDetail}
    {/if}
  </p>
  {#if !kg.available}
    <p class="warn small">
      {#if kg.mode === 'remote-gpu' || (kg.backend === 'external' && kg.sshHost)}
        Remote GPU not ready — configure SSH host + wrapper in
        <a href="/settings">Settings → Kangaroo runner</a>.
      {:else if kg.mode === 'local-gpu' || kg.backend === 'jlp'}
        Set the local CUDA binary in <a href="/settings">Settings</a>
        (or <span class="mono">KANGAROO_JLP_BIN</span>).
      {:else if kg.mode === 'custom' || kg.backend === 'external'}
        Set a custom command in <a href="/settings">Settings</a>.
      {:else}
        Binary missing — run <span class="mono">npm run grind:build</span>
        or enable a remote GPU in <a href="/settings">Settings</a>.
      {/if}
    </p>
  {:else if kg.running}
    <div class="v">
      <span class="pulse"></span>Running · puzzle #{kg.puzzleN} · {kg.mode ?? kg.backend}
      {#if kg.sshHost}<span class="faint"> · {kg.sshHost}</span>{/if}
    </div>
    <div class="metrics">
      <div><span class="faint">ops/sec</span><b class="num">{kg.opsPerSec.toLocaleString()}</b></div>
      <div><span class="faint">ops</span><b class="num">{bigCount(kg.ops)}</b></div>
      <div><span class="faint">DPs</span><b class="num">{bigCount(kg.dps)}</b></div>
      <div><span class="faint">~work</span><b class="num">2<sup>{kg.halfBits}</sup></b></div>
      <div><span class="faint">hits</span><b class="num" class:btc={kg.hits > 0}>{kg.hits}</b></div>
    </div>
    <p class="faint small mono">{shortAddr(kg.address ?? '')}</p>
    <form method="POST" action="?/kangarooStop" use:enhance>
      <button class="stop">Stop kangaroo</button>
    </form>
  {:else}
    {#if data.kangarooTargets.length === 0}
      <p class="faint small">
        No exposed+funded puzzles with stored pubkeys. Re-index puzzles after the node is up.
      </p>
    {:else}
      <form method="POST" action="?/kangarooStart" use:enhance>
        <label class="sel">
          <span class="faint">Exposed target</span>
          <select name="puzzle">
            {#each data.kangarooTargets as t}
              <option value={t.n}>
                #{t.n} · ~2^{t.halfBits} · {btcShort(t.balance)} BTC · {shortAddr(t.address)}
              </option>
            {/each}
          </select>
        </label>
        <button class="btn-accent" disabled={!kg.available}>Start kangaroo</button>
      </form>
    {/if}
    {#if kg.lastResult}
      <p class="faint small">Last: {kg.lastResult}</p>
    {/if}
  {/if}
</div>

<div class="card">
  <div class="k">Candidate sources</div>
  <table>
    <thead>
      <tr>
        <th>Source</th>
        <th>Bucket</th>
        <th class="r">Work</th>
        <th>Unit</th>
        <th>What it is</th>
      </tr>
    </thead>
    <tbody>
      {#each data.sources as s}
        <tr class:disabled={!s.available}>
          <td>{s.label}</td>
          <td><span class="badge {s.bucket === 'puzzle' ? 'solved' : 'sealed'}">{s.bucket}</span></td>
          <td class="num r">
            {#if s.spaceKind === 'rng-states'}
              ~2<sup>{s.spaceBits.toFixed(1)}</sup> states
            {:else if s.spaceKind === 'phrase-list' || s.spaceKind === 'digit-windows'}
              ~2<sup>{s.spaceBits.toFixed(0)}</sup>
            {:else}
              2<sup>{s.spaceBits.toFixed(0)}</sup> keys
            {/if}
          </td>
          <td class="faint small mono">{s.spaceUnit ?? s.spaceKind}</td>
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
  .kang-card {
    margin-bottom: 16px;
  }
  .kang-card.live {
    border-color: rgba(255, 176, 32, 0.45);
  }
  .kang-blurb {
    max-width: 780px;
    margin: 6px 0 12px;
  }
  .err {
    background: rgba(255, 87, 87, 0.1);
    border: 1px solid rgba(255, 87, 87, 0.3);
    color: var(--danger);
    padding: 10px 14px;
    border-radius: 8px;
    margin-bottom: 14px;
  }
  .warn {
    color: #f0c674;
  }
  .rng-note {
    margin: 10px 0 0;
    line-height: 1.4;
  }
  .small {
    font-size: 13px;
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
