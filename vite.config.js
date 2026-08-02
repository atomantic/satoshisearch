import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Allow access over Tailscale MagicDNS (*.ts.net) in dev. Vite 5 otherwise
// blocks requests whose Host header it doesn't recognize. Extra hosts can be
// added via ALLOWED_HOSTS (comma-separated); any *.ts.net name is allowed by
// the leading-dot entry so this isn't pinned to one tailnet.
const extraHosts = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // Port comes from PORT (set by PM2 / ecosystem.config.cjs); 3117 standalone.
    port: Number(process.env.PORT) || 3117,
    host: true,
    allowedHosts: ['.ts.net', 'localhost', ...extraHosts]
  }
});
