import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// https on purpose: ADR 0004 Decision 3 gives a third-party client NO cleartext
// loopback redirect (http://127.0.0.1 is first-party only), so this SPA — a
// registered third-party app — must be reached over https for PageSpace to
// redirect back to it. plugin-basic-ssl serves a self-signed certificate;
// accept it once in the browser.
//
// Only VITE_* reaches the bundle (Vite's default envPrefix). Do NOT widen it to
// PAGESPACE_: that would inline every PAGESPACE_* variable in the build
// environment — including a CLI token — into the public JS.
//
// @pagespace/sdk resolves to this repo's BUILT SDK (packages/sdk/dist — run
// `bun run --filter @pagespace/sdk build` first), i.e. exactly what an npm
// consumer of the next release gets, not the TypeScript sources.
export default defineConfig({
  plugins: [basicSsl()],
  resolve: {
    alias: { '@pagespace/sdk': fileURLToPath(new URL('../../packages/sdk/dist/index.js', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
