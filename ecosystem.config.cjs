// =============================================================================
// PM2 Ecosystem Configuration (PortOS-compatible)
//
// Single source of truth for the app's port — PortOS derives apps.json from
// this file, and `pm2 start ecosystem.config.cjs` launches the process. The app
// runs its SvelteKit dev server (vite reads PORT from env; see vite.config.js),
// which serves on 0.0.0.0 and accepts *.ts.net hosts so it works over Tailscale
// with no ORIGIN/CSRF setup. 3117 is the app's canonical port (matches the
// Umbrel manifest and the README); other config here can be overridden by .env.
// =============================================================================
const path = require('path');

const PORTS = {
  UI: 3117 // SvelteKit dev server (web UI)
};

const DATA_DIR = path.join(__dirname, 'data');

module.exports = {
  PORTS,

  apps: [
    {
      name: 'satoshisearch',
      script: 'npm',
      args: 'run dev',
      cwd: __dirname,
      interpreter: 'none', // `npm` is a binary, not a JS entrypoint
      env: {
        NODE_ENV: 'development',
        PORT: PORTS.UI,
        DEV_UI_PORT: PORTS.UI,
        // Point at your local mempool/electrs node. Overridable via .env.
        MEMPOOL_API_URL: 'http://100.104.209.94:3006',
        DATA_DIR
        // VAULT_KEY_HEX and rescue/sweep settings are read from .env (envFile).
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      // Generous ceiling: a grind holds the match-set + worker threads in memory
      // and a too-low cap would restart mid-run. Raise via PM2 if you grind hard.
      max_memory_restart: '2G'
    },
    /**
     * Long-lived weak-key race worker. Does not start by default with
     * `pm2 start ecosystem.config.cjs` unless you pass --only rescue-runner
     * or start it explicitly. Shares DATA_DIR with the UI.
     *
     * Override RESCUE_SOURCE / flags via env before start.
     */
    {
      name: 'rescue-runner',
      script: 'npx',
      args: 'tsx scripts/rescue-runner.ts run --source coldcard --resume --refresh-hours 12 --status-sec 30',
      cwd: __dirname,
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        DATA_DIR,
        RESCUE_NOTIFY_FILE: path.join(DATA_DIR, 'rescue-hits.jsonl')
        // RESCUE_WEBHOOK_URL: 'https://…',
        // VAULT_KEY_HEX / sweep policy: use data/settings.json or .env
      },
      watch: false,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '30s',
      restart_delay: 10_000,
      max_memory_restart: '4G'
    }
  ]
};
