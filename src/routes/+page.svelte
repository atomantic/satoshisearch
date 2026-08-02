<script lang="ts">
  import type { PageData } from './$types';
  import { btcShort } from '$lib/format';
  export let data: PageData;
  const c = data.cards;
</script>

<svelte:head><title>satoshisearch</title></svelte:head>

<section class="hero">
  <h1>The keyspace observatory</h1>
  <p class="muted">
    Watch Satoshi-era coins, track how much of Bitcoin's keyspace the world has demonstrably
    searched, and race attackers to rescue provably-weak keys — all against your own node.
  </p>
  {#if !data.nodeOk}
    <div class="alert">
      ⚠ Can't reach the mempool API at <code>{data.mempoolUrl}</code>. Set
      <code>MEMPOOL_API_URL</code> in Settings.
    </div>
  {:else}
    <div class="node-ok faint">
      ◎ node connected · tip height <span class="mono">{data.tipHeight?.toLocaleString()}</span>
    </div>
  {/if}
</section>

<div class="grid">
  <a class="card tile" href="/satoshi">
    <div class="t">Satoshi Watch</div>
    <div class="big btc">{c.dormantKnown ? btcShort(c.dormantSats) : '—'}</div>
    <div class="faint">{c.dormantKnown ? `${c.dormantCount.toLocaleString()} early coinbase outputs watched` : 'not indexed yet'}</div>
  </a>
  <a class="card tile" href="/puzzles">
    <div class="t">Puzzles</div>
    <div class="big">{c.puzzlesKnown ? c.bruteForceFrontier : '—'}<span class="unit">bit frontier</span></div>
    <div class="faint">
      {c.puzzlesKnown ? `${c.puzzleExposed} exposed · ${c.puzzleSealed} sealed unsolved` : 'not indexed yet'}
    </div>
  </a>
  <a class="card tile" href="/keyspace">
    <div class="t">Keyspace</div>
    <div class="big">72<span class="unit">bit ColdCard</span></div>
    <div class="faint">the 2026 weak-RNG depth vs the puzzle frontier</div>
  </a>
  <a class="card tile" href="/rescue">
    <div class="t">Rescue</div>
    <div class="big">{c.hits}</div>
    <div class="faint">recovered keys · {c.autoBuckets} auto-sweep bucket(s)</div>
  </a>
</div>

<style>
  .hero {
    padding: 20px 0 30px;
    max-width: 760px;
  }
  .hero h1 {
    font-size: 34px;
    margin: 0;
  }
  .hero p {
    font-size: 15px;
    margin: 12px 0 18px;
  }
  .alert {
    background: rgba(255, 87, 87, 0.1);
    border: 1px solid rgba(255, 87, 87, 0.3);
    color: var(--danger);
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
  }
  .node-ok {
    font-size: 13px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
  }
  .tile {
    display: block;
    color: var(--text);
  }
  .tile:hover {
    text-decoration: none;
    border-color: var(--border-strong);
    box-shadow: 0 0 18px var(--glow-secondary);
  }
  .tile .t {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent-soft);
  }
  .tile .big {
    font-size: 30px;
    font-weight: 700;
    margin: 8px 0 4px;
    line-height: 1;
  }
  .tile .unit {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-faint);
    margin-left: 6px;
  }
  .tile .faint {
    font-size: 12px;
  }
  @media (max-width: 820px) {
    .grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
