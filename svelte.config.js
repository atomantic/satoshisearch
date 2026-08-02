import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // node:sqlite, worker_threads, and native crypto must never be bundled
    // into the client. They are only imported from *.server.ts / lib/server.
    alias: {
      $server: 'src/lib/server'
    }
  }
};

export default config;
