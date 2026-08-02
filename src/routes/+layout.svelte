<script lang="ts">
  import '$lib/styles/app.css';
  import { page } from '$app/stores';

  const nav = [
    { href: '/', label: 'Dashboard' },
    { href: '/satoshi', label: 'Satoshi Watch' },
    { href: '/puzzles', label: 'Puzzles' },
    { href: '/keyspace', label: 'Keyspace' },
    { href: '/grinder', label: 'Grinder' },
    { href: '/rescue', label: 'Rescue' },
    { href: '/settings', label: 'Settings' }
  ];

  $: path = $page.url.pathname;
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

  // Mobile menu toggle; closes on navigation.
  let menuOpen = false;
  $: if (path) menuOpen = false;
</script>

<div class="shell">
  <header>
    <div class="container bar">
      <a class="brand" href="/">
        <span class="logo">◎</span>
        <span class="name">satoshi<b>search</b></span>
      </a>
      <button
        class="menu-toggle"
        aria-label="Toggle navigation"
        aria-expanded={menuOpen}
        on:click={() => (menuOpen = !menuOpen)}
      >
        {#if menuOpen}✕{:else}☰{/if}
      </button>
      <nav class:open={menuOpen}>
        {#each nav as item}
          <a href={item.href} class:active={active(item.href)}>{item.label}</a>
        {/each}
      </nav>
    </div>
  </header>
  <main class="container">
    <slot />
  </main>
  <footer class="container">
    <span class="faint"
      >satoshisearch · keyspace observatory &amp; white-hat rescue · runs entirely on your own
      node</span
    >
  </footer>
</div>

<style>
  .shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    border-bottom: 1px solid var(--border);
    background: rgba(26, 16, 64, 0.82);
    backdrop-filter: blur(10px);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 58px;
    gap: 24px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    color: var(--text);
    font-size: 17px;
  }
  .brand:hover {
    text-decoration: none;
  }
  .logo {
    color: var(--primary);
    font-size: 20px;
    text-shadow: 0 0 12px var(--glow-primary);
  }
  .name b {
    color: var(--primary);
    font-weight: 700;
  }
  nav {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  nav a {
    color: var(--text-dim);
    font-size: 14px;
    font-weight: 550;
    padding: 6px 11px;
    border-radius: 7px;
    white-space: nowrap;
  }
  nav a:hover {
    color: var(--text);
    text-decoration: none;
    background: var(--surface);
  }
  nav a.active {
    color: var(--primary);
    background: var(--surface);
  }
  .menu-toggle {
    display: none;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 18px;
    line-height: 1;
    padding: 7px 12px;
  }
  main {
    flex: 1;
    padding: 28px 24px 60px;
    width: 100%;
  }
  footer {
    padding: 20px 24px 30px;
    font-size: 13px;
  }

  /* Mobile: collapse the nav behind a toggle so it never overlaps content. */
  @media (max-width: 760px) {
    .bar {
      flex-wrap: wrap;
      height: auto;
      min-height: 56px;
      padding-top: 10px;
      padding-bottom: 10px;
      gap: 12px;
    }
    .menu-toggle {
      display: block;
      margin-left: auto;
    }
    nav {
      flex-basis: 100%;
      flex-direction: column;
      gap: 2px;
      display: none;
      padding-bottom: 6px;
    }
    nav.open {
      display: flex;
    }
    nav a {
      padding: 11px 12px;
      font-size: 15px;
      border-radius: 8px;
    }
    main {
      padding: 20px 16px 48px;
    }
  }
</style>
