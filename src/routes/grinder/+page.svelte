<script lang="ts">
  import type { PageData, ActionData } from './$types';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { bigCount, btcShort, shortAddr, duration } from '$lib/format';

  export let data: PageData;
  export let form: ActionData;

  // Prefer first available kangaroo target, else first grind source.
  let selected =
    data.jobs.find((j) => j.available && j.method === 'kangaroo')?.id ??
    data.jobs.find((j) => j.available)?.id ??
    '';

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
  $: selectedJob = data.jobs.find((j) => j.id === selected) ?? null;
  $: method = selectedJob?.method ?? 'grind';
  $: isRunning = st.running || kg.running;

  // Pollard's kangaroo ETA at current rate.
  $: expectedOps = kg.halfBits === null ? null : Math.pow(2, kg.halfBits);
  $: etaSeconds =
    expectedOps !== null && kg.opsPerSec > 0
      ? Math.max(0, expectedOps - kg.ops) / kg.opsPerSec
      : null;
</script>

<svelte:head><title>Grinder · satoshisearch</title></svelte:head>

<div class="head">
  <h1>Key Grinder</h1>
  <p class="muted">
    Pick a target and Start. <b>Exposed puzzles</b> use Pollard's kangaroo (ECDLP);
    everything else walks keys sequentially against
    {bigCount(matchN)} watched targets ({bigCount(data.matchSet.hash160s)} hash160 · {data.matchSet.pubkeys}
    P2PK pubkeys). Managed devices (local CPU, remote hosts) run either job kind when capable.
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
  <b>Honest math:</b> sequential ranges and weak-RNG sources are different from kangaroo.
  Exposed puzzles with a known pubkey fall to ~2<sup>n/2</sup> ECDLP work on GPU/CPU solvers.
  Sealed ranges and ColdCard walk keys or RNG states — the remote GPU's CUDA cores only help kangaroo;
  its CPU can still join sequential grind when grind is enabled on that device.
</div>

{#if form?.error}<div class="err">{form.error}</div>{/if}

<div class="grid">
  <div class="card status-card" class:live={isRunning} class:kang-live={kg.running}>
    <div class="k">Status</div>

    {#if st.running}
      <div class="v"><span class="pulse"></span>Running · grind · {st.sourceName}</div>
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
      {#if st.deviceIds?.length}
        <p class="faint small rng-note">
          Devices: <span class="mono">{st.deviceIds.join(', ')}</span>
        </p>
      {/if}
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
    {:else if kg.running}
      <div class="v">
        <span class="pulse kang-pulse"></span>Running · kangaroo · puzzle #{kg.puzzleN}
        <span class="faint"> · {kg.activeRunnerIds?.length ?? 0} device(s)</span>
      </div>
      <div class="metrics">
        <div><span class="faint">ops/sec (Σ)</span><b class="num">{kg.opsPerSec.toLocaleString()}</b></div>
        <div><span class="faint">ops (Σ)</span><b class="num">{bigCount(kg.ops)}</b></div>
        <div><span class="faint">DPs</span><b class="num">{bigCount(kg.dps)}</b></div>
        <div><span class="faint">~work</span><b class="num">2<sup>{kg.halfBits}</sup></b></div>
        <div
          title="Time to reach the expected work at the current rate. The search is probabilistic — it can land far sooner or later."
        >
          <span class="faint">eta @ rate</span><b class="num">{duration(etaSeconds)}</b>
        </div>
        <div><span class="faint">hits</span><b class="num" class:btc={kg.hits > 0}>{kg.hits}</b></div>
      </div>
      <p class="target">
        <span class="faint small">target</span>
        {#if kg.addressLink}
          <a class="mono addr" href={kg.addressLink} target="_blank" rel="noreferrer">{kg.address}</a>
        {:else}
          <span class="mono addr">{kg.address}</span>
        {/if}
        {#if kg.balance !== null}
          <span class="bal btc">{btcShort(kg.balance)} BTC</span>
        {/if}
      </p>
      <p class="faint small mono">{kg.backendDetail}</p>
      {#if kg.runners?.length}
        <ul class="runner-list">
          {#each kg.runners as r}
            {#if kg.activeRunnerIds?.includes(r.id)}
              <li class:live={r.status === 'running'}>
                <span class="dot" class:ok={r.available && r.enabled}></span>
                <b>{r.name}</b>
                <span class="mono"> · {Math.round(r.opsPerSec).toLocaleString()}/s · {r.status}</span>
              </li>
            {/if}
          {/each}
        </ul>
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
      <p class="faint small rng-note">
        This status is the <em>UI process</em> only. A separate
        <span class="mono">pm2</span> <span class="mono">rescue-runner</span> can grind
        against the same DB — stop it with
        <span class="mono">pm2 stop rescue-runner</span> if logs keep scrolling while this is Idle.
      </p>

      <form method="POST" action="?/start" use:enhance>
        <label class="sel">
          <span class="faint">Target</span>
          <select name="job" bind:value={selected}>
            {#each data.jobs as j}
              <option value={j.id} disabled={!j.available}>
                {#if j.method === 'kangaroo'}
                  #{j.puzzleN} kangaroo · ~2^{j.halfBits} · {btcShort(j.balance ?? 0)} BTC
                  {j.address ? ` · ${shortAddr(j.address)}` : ''}
                {:else}
                  {j.label}{j.available ? '' : ' — ' + (j.note ?? 'unavailable')}
                {/if}
              </option>
            {/each}
          </select>
        </label>

        {#if selectedJob}
          <p class="method-hint faint small">
            Method:
            {#if method === 'kangaroo'}
              <b>Pollard's kangaroo</b> (interval ECDLP)
              {#if !kg.available}
                <span class="warn"> — no kangaroo-ready devices</span>
              {/if}
            {:else}
              <b>Sequential grind</b>
            {/if}
            {#if selectedJob.detail}
              <span class="block-detail">{selectedJob.detail}</span>
            {/if}
          </p>
        {/if}

        {#if data.devices.length}
          <fieldset class="runner-pick">
            <legend class="faint">
              Devices
              {#if method === 'kangaroo'}
                (race kangaroo; first find wins)
              {:else}
                (fan-out grind; remote needs satoshi-grind)
              {/if}
            </legend>
            {#each data.devices as d}
              {@const capOk = method === 'kangaroo' ? d.kangarooAvailable : d.grindAvailable}
              <label class="runner-check" class:off={!capOk}>
                <input
                  type="checkbox"
                  name="devices"
                  value={d.id}
                  checked={d.enabled && capOk}
                  disabled={!capOk}
                />
                {d.name}
                <span class="faint mono">
                  ({d.kind}{d.sshHost ? ` · ${d.sshHost}` : ''})
                </span>
                {#if !capOk}
                  <span class="warn">
                    · {method === 'kangaroo' ? 'no kangaroo' : d.grindDetail || 'grind off'}
                  </span>
                {/if}
              </label>
            {/each}
          </fieldset>
        {:else}
          <p class="warn small">
            No devices configured —
            <a href="/settings">Settings → Compute devices</a>.
          </p>
        {/if}

        <button
          class="btn-accent"
          disabled={method === 'kangaroo' ? !kg.available : !selectedJob?.available}
        >
          Start
        </button>
      </form>

      {#if kg.lastResult && !st.running}
        <p class="faint small">Last kangaroo: {kg.lastResult}</p>
      {/if}
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

    <div class="k" style="margin-top: 16px;">Devices</div>
    {#if data.devices.length}
      <ul class="runner-list">
        {#each data.devices as d}
          <li class:off={!d.enabled}>
            <span
              class="dot"
              class:ok={d.enabled && d.available}
              class:warn={d.enabled && !d.available}
            ></span>
            <b>{d.name}</b>
            <span class="faint mono">
              · {d.capabilities?.length ? d.capabilities.join('+') : '—'}
              {d.sshHost ? ` · ${d.sshHost}` : ''}
            </span>
          </li>
        {/each}
      </ul>
      <a href="/settings" class="faint small">Manage devices →</a>
    {:else}
      <p class="faint small">None configured.</p>
    {/if}
  </div>
</div>

<div class="card">
  <div class="k">Targets &amp; sources</div>
  <table>
    <thead>
      <tr>
        <th>Target</th>
        <th>Method</th>
        <th>Bucket</th>
        <th class="r">Work</th>
        <th>Unit</th>
        <th>What it is</th>
      </tr>
    </thead>
    <tbody>
      {#each data.jobs as j}
        <tr class:disabled={!j.available}>
          <td>{j.label}</td>
          <td>
            <span class="badge {j.method === 'kangaroo' ? 'solved' : 'sealed'}">
              {j.method === 'kangaroo' ? 'kangaroo' : 'grind'}
            </span>
          </td>
          <td><span class="badge {j.bucket === 'puzzle' ? 'solved' : 'sealed'}">{j.bucket}</span></td>
          <td class="num r">
            {#if j.method === 'kangaroo'}
              ~2<sup>{j.halfBits}</sup>
            {:else if j.spaceKind === 'rng-states'}
              ~2<sup>{j.spaceBits.toFixed(1)}</sup> states
            {:else if j.spaceKind === 'phrase-list' || j.spaceKind === 'digit-windows'}
              ~2<sup>{j.spaceBits.toFixed(0)}</sup>
            {:else}
              2<sup>{j.spaceBits.toFixed(0)}</sup> keys
            {/if}
          </td>
          <td class="faint small mono">{j.spaceUnit ?? j.spaceKind}</td>
          <td class="faint small">{j.detail}</td>
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
  .method-hint {
    margin: 0 0 10px;
    line-height: 1.4;
  }
  .block-detail {
    display: block;
    margin-top: 4px;
    opacity: 0.9;
  }
  .runner-list {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    font-size: 13px;
  }
  .runner-list li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
    padding: 3px 0;
  }
  .runner-list li.off {
    opacity: 0.5;
  }
  .runner-list .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-faint);
    flex-shrink: 0;
  }
  .runner-list .dot.ok {
    background: var(--success);
  }
  .runner-list .dot.warn {
    background: #f0c674;
  }
  .runner-pick {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 8px 12px;
    margin: 10px 0;
  }
  .runner-pick legend {
    padding: 0 4px;
    font-size: 12px;
  }
  .runner-check {
    display: block;
    font-size: 13px;
    margin: 4px 0;
  }
  .runner-check.off {
    opacity: 0.5;
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
    flex-wrap: wrap;
  }
  .status-card.live {
    border-color: rgba(123, 255, 160, 0.4);
  }
  .status-card.kang-live {
    border-color: rgba(255, 176, 32, 0.45);
  }
  .pulse {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 0 0 var(--glow-success);
    animation: pulse 1.4s infinite;
  }
  .kang-pulse {
    background: #ffb020;
    box-shadow: 0 0 0 0 rgba(255, 176, 32, 0.5);
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
  .target {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 8px;
    margin: 0 0 12px;
  }
  .addr {
    font-size: 12px;
    word-break: break-all;
  }
  .bal {
    font-size: 12px;
    white-space: nowrap;
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
