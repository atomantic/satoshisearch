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
</script>

<div class="shell">
  <header>
    <div class="container bar">
      <a class="brand" href="/">
        <span class="logo">◎</span>
        <span class="name">satoshi<b>search</b></span>
      </a>
      <nav>
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
  main {
    flex: 1;
    padding: 28px 24px 60px;
    width: 100%;
  }
  footer {
    padding: 20px 24px 30px;
    font-size: 13px;
  }
</style>
