import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';

// Allow access over Tailscale MagicDNS (*.ts.net) in dev. Vite 5 otherwise
// blocks requests whose Host header it doesn't recognize. Extra hosts can be
// added via ALLOWED_HOSTS (comma-separated); any *.ts.net name is allowed by
// the leading-dot entry so this isn't pinned to one tailnet.
const extraHosts = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// `.ts.net` is on the HSTS preload list, so browsers force-upgrade every
// http:// URL on a MagicDNS name to https:// — a plain-HTTP dev server on a
// tailnet host is simply unreachable from a browser (it never even sends the
// request). Serving TLS is therefore mandatory here, not a nicety.
//
// The cert is the Tailscale-issued one PortOS provisions; we read it rather
// than mint our own so every app on this tailnet shares a single trusted cert.
// Search order lets the app run standalone (no PortOS checkout) or with an
// explicit override, and it degrades to plain HTTP when no cert is found so
// `vite dev` on localhost still works.
//
// Caveat: Vite reads the cert once, at config load. When the Tailscale cert is
// renewed this dev server keeps serving the old one until it is restarted.
const certDirs = [
  process.env.CERT_DIR,
  join(repoRoot, 'certs'),
  join(repoRoot, '..', 'PortOS', 'data', 'certs')
].filter(Boolean);

function loadCert() {
  for (const dir of certDirs) {
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    if (!existsSync(cert) || !existsSync(key)) continue;
    // A cert/key pair can exist but be empty or half-written if a provisioner
    // was interrupted. createSecureContext is what the HTTPS server uses
    // internally, so validating with it here means an unparseable pair falls
    // through to the next candidate (and ultimately to HTTP) instead of
    // crashing the dev server on boot.
    try {
      const pair = { cert: readFileSync(cert), key: readFileSync(key) };
      createSecureContext(pair);
      return pair;
    } catch {
      continue;
    }
  }
  return null;
}

const https = loadCert();
console.log(
  https
    ? '🔐 dev server: HTTPS (tailscale cert)'
    : '🔓 dev server: HTTP (no cert found — https://*.ts.net will not load)'
);

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // Port comes from PORT (set by PM2 / ecosystem.config.cjs); 3117 standalone.
    port: Number(process.env.PORT) || 3117,
    host: true,
    allowedHosts: ['.ts.net', 'localhost', ...extraHosts],
    // Undefined (not `false`) when absent so Vite keeps its plain-HTTP default.
    ...(https ? { https } : {})
  }
});
