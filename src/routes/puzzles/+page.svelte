<script lang="ts">
  import type { PageData } from './$types';
  import { btcShort, shortAddr } from '$lib/format';

  export let data: PageData;

  type Filter = 'all' | 'sealed' | 'exposed' | 'solved';
  const filters: Filter[] = ['all', 'sealed', 'exposed', 'solved'];
  let filter: Filter = 'all';

  $: rows = data.rows.filter((r) => filter === 'all' || r.status === filter);
  const s = data.stats;
</script>

<svelte:head><title>Puzzles · satoshisearch</title></svelte:head>

<div class="head">
  <div>
    <h1>Bitcoin Puzzle Tracker</h1>
    <p class="muted">
      All 256 puzzle outputs, derived live from the 2015 funding transaction and classified against
      your node. No third-party scraping — status comes straight from the chain.
    </p>
  </div>
</div>

{#if !data.indexed}
  <div class="card empty">
    <p>No puzzle data yet. Run the indexer:</p>
    <pre class="mono">npm run index:puzzles</pre>
  </div>
{:else}
  <div class="stats">
    <div class="card stat">
      <div class="k">Brute-force frontier</div>
      <div class="v big">{s.bruteForceFrontier}<span class="unit">bits</span></div>
      <div class="sub faint">largest fully-solved sealed range</div>
    </div>
    <div class="card stat">
      <div class="k">Sealed &amp; funded</div>
      <div class="v">{s.sealed}</div>
      <div class="sub faint">hash160-only · full brute force</div>
    </div>
    <div class="card stat danger">
      <div class="k">Exposed &amp; funded</div>
      <div class="v">{s.exposed}</div>
      <div class="sub">
        <span class="btc">{btcShort(s.atRiskSats)} BTC</span> at risk · kangaroo ~N/2 bits
      </div>
    </div>
    <div class="card stat">
      <div class="k">Still funded</div>
      <div class="v btc">{btcShort(s.fundedSats)}</div>
      <div class="sub faint">BTC across {s.sealed + s.exposed} unsolved</div>
    </div>
  </div>

  <div class="toolbar">
    <div class="filters">
      {#each filters as f}
        <button class:active={filter === f} on:click={() => (filter = f)}>{f}</button>
      {/each}
    </div>
    <div class="legend faint">
      <span class="dot sealed"></span> sealed
      <span class="dot exposed"></span> exposed
      <span class="dot solved"></span> solved
    </div>
  </div>

  <div class="card table-wrap">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Key range</th>
          <th>Address</th>
          <th>Status</th>
          <th class="r">Balance</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.n)}
          <tr>
            <td class="num">{r.n}</td>
            <td class="num faint">2<sup>{r.n - 1}</sup>–2<sup>{r.n}</sup></td>
            <td class="mono">
              {#if r.addressLink}
                <a href={r.addressLink} target="_blank" rel="noreferrer">{shortAddr(r.address)}</a>
              {:else}{shortAddr(r.address)}{/if}
            </td>
            <td><span class="badge {r.status}">{r.status}</span></td>
            <td class="num r" class:btc={r.balance > 0}>{r.balance > 0 ? btcShort(r.balance) : '—'}</td>
            <td class="faint small">
              {#if r.status === 'exposed'}
                pubkey public
                {#if r.solveLink}· <a href={r.solveLink} target="_blank" rel="noreferrer">reveal tx</a>{/if}
              {:else if r.status === 'solved' && r.solveLink}
                <a href={r.solveLink} target="_blank" rel="noreferrer">solve tx</a>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .head {
    margin-bottom: 22px;
  }
  .head p {
    max-width: 720px;
    margin: 6px 0 0;
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
    font-size: 30px;
    font-weight: 700;
    margin-top: 4px;
    line-height: 1;
  }
  .stat .v.big .unit {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-faint);
    margin-left: 5px;
  }
  .stat .sub {
    font-size: 12px;
    margin-top: 6px;
  }
  .stat.danger {
    border-color: rgba(255, 87, 87, 0.35);
  }
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .filters {
    display: flex;
    gap: 6px;
  }
  .filters button {
    text-transform: capitalize;
    padding: 6px 12px;
  }
  .filters button.active {
    border-color: var(--primary);
    color: var(--primary);
  }
  .legend {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
  }
  .dot {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin-right: 2px;
  }
  .dot.sealed {
    background: var(--warning);
  }
  .dot.exposed {
    background: var(--danger);
  }
  .dot.solved {
    background: var(--text-faint);
  }
  .table-wrap {
    padding: 4px 4px 0;
    overflow-x: auto;
  }
  .r {
    text-align: right;
  }
  td.small {
    font-size: 12px;
  }
  sup {
    font-size: 0.7em;
  }
  .empty pre {
    background: var(--bg);
    padding: 10px 14px;
    border-radius: 6px;
    display: inline-block;
    margin-top: 8px;
  }
  @media (max-width: 820px) {
    .stats {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
