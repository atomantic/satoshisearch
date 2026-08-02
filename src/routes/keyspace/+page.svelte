<script lang="ts">
  import type { PageData } from './$types';
  import { btcShort, shortAddr } from '$lib/format';

  export let data: PageData;

  // Axis geometry: linear 0..256 bits. Bits are already log2(keyspace), so a
  // linear bit axis is the honest scale — each +1 doubles the work.
  const MAX = 256;
  const W = 1000;
  const H = 172;
  const padL = 8;
  const padR = 8;
  const axisY = 74;
  const x = (bits: number) => padL + (bits / MAX) * (W - padL - padR);

  $: a = data.indexed ? data.analysis : null;

  let hover: { label: string; sub: string } | null = null;
  function show(label: string, sub: string) {
    hover = { label, sub };
  }
</script>

<svelte:head><title>Keyspace · satoshisearch</title></svelte:head>

<div class="head">
  <h1>Keyspace Frontier</h1>
  <p class="muted">
    How much of Bitcoin's 256-bit private-key space has the world demonstrably searched? The puzzle
    series is the natural experiment — every solved puzzle is a public proof that someone traversed
    that range. Read against the known weak-key depths, it shows exactly where the danger is.
  </p>
</div>

{#if !data.indexed}
  <div class="card"><p>Run <code>npm run index:puzzles</code> to populate the frontier.</p></div>
{:else if a}
  <div class="headline-row">
    <div class="card headline">
      <div class="k">Brute-force frontier</div>
      <div class="v">{a.bruteForceFrontier}<span class="u">bits</span></div>
      <div class="sub faint">
        every sealed puzzle up to here is solved — the deepest a full key search has publicly reached
      </div>
    </div>
    <div class="card headline">
      <div class="k">ECDLP frontier</div>
      <div class="v">{a.ecdlpFrontier}<span class="u">bits</span></div>
      <div class="sub faint">deepest solved with a <em>public pubkey</em> (kangaroo, ~N/2 work)</div>
    </div>
    <div class="card headline danger">
      <div class="k">Exposed &amp; funded</div>
      <div class="v">{a.atRisk.length}</div>
      <div class="sub"><span class="btc">{btcShort(a.atRiskSats)} BTC</span> attackable now at ~N/2 bits</div>
    </div>
  </div>

  <div class="card chart-card">
    <div class="chart-title">
      The 256-bit key space — searched, exposed, and safe
      {#if hover}<span class="hovertip">{hover.label} · {hover.sub}</span>{/if}
    </div>
    <div class="axis-scroll">
    <svg viewBox="0 0 {W} {H}" class="axis" role="img" aria-label="Bit-depth frontier">
      <defs>
        <linearGradient id="solved" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#7bffa0" stop-opacity="0.55" />
          <stop offset="1" stop-color="#7bffa0" stop-opacity="0.9" />
        </linearGradient>
        <linearGradient id="ecdlp" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#4df4ff" stop-opacity="0.35" />
          <stop offset="1" stop-color="#4df4ff" stop-opacity="0.6" />
        </linearGradient>
      </defs>

      <rect x={padL} y={axisY - 7} width={W - padL - padR} height="14" rx="4" fill="#34215f" />
      <rect x={padL} y={axisY - 7} width={x(a.ecdlpFrontier) - padL} height="14" rx="4" fill="url(#ecdlp)" />
      <rect x={padL} y={axisY - 7} width={x(a.bruteForceFrontier) - padL} height="14" rx="4" fill="url(#solved)" />

      <g
        role="button"
        tabindex="0"
        on:mouseenter={() => show('Brute-force frontier', `${a.bruteForceFrontier} bits fully searched`)}
        on:mouseleave={() => (hover = null)}
      >
        <line x1={x(a.bruteForceFrontier)} y1={axisY - 20} x2={x(a.bruteForceFrontier)} y2={axisY + 12} stroke="#7bffa0" stroke-width="2" />
        <text x={x(a.bruteForceFrontier)} y={axisY - 25} text-anchor="middle" class="lbl frontier">{a.bruteForceFrontier}-bit frontier</text>
      </g>

      {#each a.bands as band}
        {@const anchor = band.bits >= 248 ? 'end' : band.bits <= 8 ? 'start' : 'middle'}
        {@const drop = band.kind === 'satoshi' ? 26 : 0}
        <g
          class="band {band.kind}"
          role="button"
          tabindex="0"
          on:mouseenter={() => show(band.label, band.note)}
          on:mouseleave={() => (hover = null)}
        >
          <line x1={x(band.bits)} y1={axisY + 7} x2={x(band.bits)} y2={axisY + 26 + drop} stroke-width="2" />
          <circle cx={x(band.bits)} cy={axisY} r="4" />
          <text x={x(band.bits)} y={axisY + 40 + drop} text-anchor={anchor} class="lbl band-lbl">{band.label}</text>
          <text x={x(band.bits)} y={axisY + 52 + drop} text-anchor={anchor} class="lbl band-bits">{band.bits}b</text>
        </g>
      {/each}

      {#each a.atRisk as r}
        <g
          class="atrisk"
          role="button"
          tabindex="0"
          on:mouseenter={() => show(`Puzzle ${r.n} exposed`, `${btcShort(r.balanceSats)} BTC · effective ${r.halfBits} bits`)}
          on:mouseleave={() => (hover = null)}
        >
          <line x1={x(r.n)} y1={axisY - 7} x2={x(r.n)} y2={axisY - 16} stroke="#ff5757" stroke-width="1.5" />
        </g>
      {/each}

      {#each [0, 64, 192, 256] as t}
        {@const anc = t >= 256 ? 'end' : t <= 0 ? 'start' : 'middle'}
        <text x={x(t)} y={axisY + 96} text-anchor={anc} class="lbl scale">{t}</text>
      {/each}
    </svg>
    </div>

    <div class="insight">
      <span class="dot danger"></span>
      The <b>ColdCard 2026</b> flaw collapsed seed entropy to <b>72 bits</b> — only
      <b>{72 - a.bruteForceFrontier}</b> bits beyond the demonstrated public brute-force frontier of
      <b>{a.bruteForceFrontier} bits</b>. That is why ~1,082 BTC was swept in 41 minutes: the weak
      keys sat right at the edge of reachable space.
    </div>
  </div>

  {#if a.projection.bitsPerYear && a.projection.bitsPerYear > 0}
    <div class="card proj">
      <div class="k">Frontier trend</div>
      <p class="muted">
        Sealed puzzle solves advance the frontier at ≈
        <b>{a.projection.bitsPerYear.toFixed(2)} bits/year</b>.
        {#if a.projection.etaYear && a.projection.etaYear > new Date().getFullYear()}
          At that rate the next sealed bit (puzzle {a.projection.nextBit}) falls around
          <b>{Math.round(a.projection.etaYear)}</b>.
        {:else}
          The trend already puts the next sealed bit (puzzle {a.projection.nextBit}) within reach —
          it is overdue, which is exactly why 71 and 72 are the live brute-force battleground.
        {/if}
        Doubling hardware adds only one bit, so this crawls — the point being that brute force does
        not threaten 128-bit keys.
      </p>
    </div>
  {/if}

  {#if a.atRisk.length}
    <div class="card">
      <div class="k danger-k">At-risk: exposed &amp; still funded</div>
      <p class="faint small">
        These puzzles have a public key on-chain and hold a balance, so they are attackable now at
        roughly half their bit-length via Pollard's kangaroo.
      </p>
      <table>
        <thead>
          <tr><th>#</th><th>Address</th><th class="r">Bits</th><th class="r">Effective (~N/2)</th><th class="r">Balance</th></tr>
        </thead>
        <tbody>
          {#each a.atRisk as r}
            <tr>
              <td class="num">{r.n}</td>
              <td class="mono">
                {#if r.link}<a href={r.link} target="_blank" rel="noreferrer">{shortAddr(r.address)}</a>{:else}{shortAddr(r.address)}{/if}
              </td>
              <td class="num r">{r.bits}</td>
              <td class="num r warn">{r.halfBits}</td>
              <td class="num r btc">{btcShort(r.balanceSats)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<style>
  .head {
    margin-bottom: 20px;
  }
  .head p {
    max-width: 780px;
    margin: 6px 0 0;
  }
  .headline-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin-bottom: 16px;
  }
  .headline .k {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent-soft);
  }
  .headline .v {
    font-size: 34px;
    font-weight: 700;
    line-height: 1;
    margin: 6px 0 5px;
  }
  .headline .v .u {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-faint);
    margin-left: 6px;
  }
  .headline .sub {
    font-size: 12px;
  }
  .headline.danger {
    border-color: rgba(255, 87, 87, 0.35);
  }
  .chart-card {
    margin-bottom: 16px;
  }
  .chart-title {
    font-size: 13px;
    color: var(--accent-soft);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
    display: flex;
    gap: 12px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .hovertip {
    color: var(--text);
    text-transform: none;
    letter-spacing: 0;
    font-size: 12px;
    background: var(--surface-2);
    padding: 2px 8px;
    border-radius: 5px;
    border: 1px solid var(--border);
  }
  .axis-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    margin: 0 -4px;
  }
  .axis {
    width: 100%;
    height: auto;
    overflow: visible;
  }
  .axis .lbl {
    font-family: var(--mono);
    fill: var(--text-dim);
  }
  .axis .frontier {
    fill: var(--success);
    font-size: 13px;
    font-weight: 600;
  }
  .axis .scale {
    fill: var(--text-faint);
    font-size: 11px;
  }
  .axis .band-lbl {
    font-size: 11px;
  }
  .axis .band-bits {
    font-size: 10px;
    fill: var(--text-faint);
  }
  .axis .band.threat line,
  .axis .band.threat circle {
    stroke: var(--danger);
    fill: var(--danger);
  }
  .axis .band.safe line,
  .axis .band.safe circle {
    stroke: var(--secondary);
    fill: var(--secondary);
  }
  .axis .band.satoshi line,
  .axis .band.satoshi circle {
    stroke: var(--btc);
    fill: var(--btc);
  }
  .axis g[role='button'] {
    cursor: pointer;
  }
  .insight {
    margin-top: 14px;
    font-size: 13px;
    line-height: 1.6;
    background: rgba(255, 87, 87, 0.07);
    border: 1px solid rgba(255, 87, 87, 0.22);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .insight b {
    color: var(--text);
  }
  .dot {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin-right: 6px;
  }
  .dot.danger {
    background: var(--danger);
  }
  .proj {
    margin-bottom: 16px;
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
  .r {
    text-align: right;
  }
  .warn {
    color: var(--warning);
  }
  .small {
    font-size: 12px;
    margin: 0 0 8px;
  }
  @media (max-width: 820px) {
    .headline-row {
      grid-template-columns: 1fr;
    }
  }
  /* Keep the bit-axis labels legible by scrolling rather than shrinking. */
  @media (max-width: 640px) {
    .axis {
      min-width: 620px;
    }
  }
</style>
