<script lang="ts">
  import type { PageData, ActionData } from './$types';
  import { enhance } from '$app/forms';
  import { btcShort, shortAddr, timeAgo } from '$lib/format';
  export let data: PageData;
  export let form: ActionData;
  $: v = form?.verification ?? data.verification;
</script>

<svelte:head><title>Rescue · satoshisearch</title></svelte:head>

<div class="head">
  <h1>Rescue &amp; Audit</h1>
  <p class="muted">
    When the grinder finds a funded key, the event is recorded in a tamper-evident, hash-chained
    audit log and the key is encrypted at rest — before any sweep — so a rightful owner can always be
    identified and reimbursed. Sweeping follows the per-bucket policy; everything else is held.
  </p>
</div>

<div class="stats">
  <div class="card stat">
    <div class="k">Recovered keys</div>
    <div class="v">{data.totals.hits}</div>
    <div class="sub faint">{data.totals.swept} swept · {data.totals.held} held</div>
  </div>
  <div class="card stat">
    <div class="k">Value found</div>
    <div class="v btc">{btcShort(data.totals.sats)}</div>
    <div class="sub faint">BTC at time of discovery</div>
  </div>
  <div class="card stat" class:danger={!v.ok}>
    <div class="k">Audit chain</div>
    <div class="v" class:ok={v.ok} class:bad={!v.ok}>{v.ok ? 'intact' : 'BROKEN'}</div>
    <div class="sub faint">{v.count} records{v.ok ? '' : ` · broke at #${v.brokenAtSeq}`}</div>
  </div>
  <div class="card stat">
    <div class="k">Vault</div>
    <div class="v small-v" class:ok={data.vaultReady} class:bad={!data.vaultReady}>{data.vaultReady ? 'ready' : 'unset'}</div>
    <div class="sub faint">AES-256-GCM at rest</div>
  </div>
</div>

<div class="card policy">
  <div class="k">Active policy</div>
  <div class="pgrid faint">
    <div>Destination: <b class="mono">{data.policy.dest ? shortAddr(data.policy.dest) : 'none (fail-safe hold)'}</b></div>
    <div>Broadcast: <b>{data.policy.dryRun ? 'dry-run (off)' : 'LIVE'}</b></div>
    <div>Auto-sweep buckets: <b>{data.policy.autoBuckets.join(', ') || 'none'}</b></div>
    <div>White-hat attested: <b>{data.policy.whitehatAttested ? 'yes' : 'no'}</b></div>
    <div>Dust floor: <b>{data.policy.dustSats.toLocaleString()} sats</b></div>
  </div>
</div>

<div class="card readiness">
  <div class="k">Realtime rescue readiness · bucket {data.readiness.primaryBucket}</div>
  <div class="ready-flags">
    <span class="flag" class:ok={data.readiness.canGrind} class:bad={!data.readiness.canGrind}>
      grind {data.readiness.canGrind ? 'ready' : 'blocked'}
    </span>
    <span class="flag" class:ok={data.readiness.canDryRunSweep} class:bad={!data.readiness.canDryRunSweep}>
      dry-run sweep {data.readiness.canDryRunSweep ? 'ready' : 'no'}
    </span>
    <span class="flag" class:ok={data.readiness.canLiveSweep} class:warn={!data.readiness.canLiveSweep && data.readiness.canDryRunSweep} class:bad={!data.readiness.canDryRunSweep}>
      live sweep {data.readiness.canLiveSweep ? 'ARMED' : 'safe (off)'}
    </span>
  </div>
  <ul class="checks">
    {#each data.readiness.checks as c}
      <li class={c.level}>
        <span class="lvl">{c.level}</span>
        <span class="lab">{c.label}</span>
        <span class="det faint">{c.detail}</span>
      </li>
    {/each}
  </ul>
  <p class="faint small">
    CLI: <span class="mono">npm run rescue:check</span>
    · runner: <span class="mono">npm run rescue:run -- --source coldcard --resume</span>
    · see <span class="mono">docs/RESCUE-RUNNER.md</span>
  </p>
</div>

{#if data.hits.length}
  <div class="card">
    <div class="k">Recovered keys &amp; claims</div>
    <table>
      <thead><tr><th>Found</th><th>Bucket</th><th>Source</th><th>Address</th><th class="r">Balance</th><th>Status</th><th>Sweep</th></tr></thead>
      <tbody>
        {#each data.hits as h}
          <tr>
            <td class="faint num">{timeAgo(h.found_at)}</td>
            <td><span class="badge {h.bucket === 'puzzle' ? 'solved' : 'sealed'}">{h.bucket}</span></td>
            <td class="faint small">{h.source_name}</td>
            <td class="mono">{#if h.link}<a href={h.link} target="_blank" rel="noreferrer">{shortAddr(h.address ?? '')}</a>{:else}—{/if}</td>
            <td class="num r btc">{btcShort(h.bal)}</td>
            <td><span class="status {h.status}">{h.status}</span></td>
            <td class="mono small">{#if h.txLink}<a href={h.txLink} target="_blank" rel="noreferrer">tx</a>{:else}—{/if}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <div class="card"><p class="faint">No keys recovered yet. Run a grind from the <a href="/grinder">Grinder</a>.</p></div>
{/if}

<div class="card">
  <div class="audit-head">
    <div class="k">Audit log (hash-chained)</div>
    <form method="POST" action="?/verify" use:enhance><button>Verify chain</button></form>
  </div>
  {#if data.audit.length}
    <table>
      <thead><tr><th>#</th><th>When</th><th>Event</th><th>Detail</th></tr></thead>
      <tbody>
        {#each data.audit as e}
          <tr>
            <td class="num faint">{e.seq}</td>
            <td class="faint num">{timeAgo(e.ts)}</td>
            <td><span class="evt">{e.event}</span></td>
            <td class="faint small mono">{JSON.stringify(e.payload).slice(0, 90)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="faint small">No audit events yet.</p>
  {/if}
</div>

<style>
  .head { margin-bottom: 20px; }
  .head p { max-width: 760px; margin: 6px 0 0; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 16px; }
  .stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-soft); }
  .stat .v { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .stat .v.small-v { font-size: 20px; }
  .stat .v.ok { color: var(--success); }
  .stat .v.bad { color: var(--danger); }
  .stat .sub { font-size: 12px; margin-top: 6px; }
  .stat.danger { border-color: rgba(255, 87, 87, 0.4); }
  .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-soft); margin-bottom: 8px; }
  .policy { margin-bottom: 16px; }
  .readiness { margin-bottom: 16px; }
  .ready-flags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .flag {
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
  }
  .flag.ok { color: var(--success); background: rgba(123, 255, 160, 0.12); }
  .flag.warn { color: var(--warning); background: rgba(255, 155, 61, 0.12); }
  .flag.bad { color: var(--danger); background: rgba(255, 87, 87, 0.12); }
  .checks { list-style: none; padding: 0; margin: 0 0 10px; }
  .checks li {
    display: grid;
    grid-template-columns: 48px 140px 1fr;
    gap: 8px;
    font-size: 12px;
    padding: 4px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }
  .checks .lvl { font-family: var(--mono); text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; }
  .checks li.ok .lvl { color: var(--success); }
  .checks li.warn .lvl { color: var(--warning); }
  .checks li.fail .lvl { color: var(--danger); }
  .checks .lab { color: var(--text); }
  .pgrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 24px; font-size: 13px; }
  .pgrid b { color: var(--text); }
  .r { text-align: right; }
  .small { font-size: 12px; }
  .status { font-size: 11px; text-transform: uppercase; padding: 2px 7px; border-radius: 5px; }
  .status.swept { color: var(--success); background: rgba(123,255,160,0.12); }
  .status.held { color: var(--warning); background: rgba(255,155,61,0.12); }
  .status\.dry-run, .status.dry-run { color: var(--secondary); background: rgba(77,244,255,0.1); }
  .status.failed { color: var(--danger); background: rgba(255,87,87,0.12); }
  .audit-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .evt { font-family: var(--mono); font-size: 12px; color: var(--accent-soft); }
  @media (max-width: 820px) { .stats { grid-template-columns: repeat(2, 1fr); } .pgrid { grid-template-columns: 1fr; } }
</style>
