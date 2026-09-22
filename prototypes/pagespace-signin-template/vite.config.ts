import { defineConfig, type Plugin } from 'vite';
import { pagespaceConfigScript } from './pagespace-config.mjs';

/**
 * Serves /pagespace-config.js in DEV exactly as server.mjs serves it in
 * production: the two public values, read from process.env at request time.
 * Deliberately not `define`/`import.meta.env`: those inline at BUILD time, and
 * the published machine sets PAGESPACE_URL / PAGESPACE_CLIENT_ID when it boots,
 * after the build ran. Keep Vite's default `envPrefix` (VITE_): widening it to
 * PAGESPACE_ would inline every PAGESPACE_* variable into public JS.
 */
function pagespaceConfig(): Plugin {
  return {
    name: 'pagespace-config',
    configureServer(server) {
      server.middlewares.use('/pagespace-config.js', (_req, res) => {
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(pagespaceConfigScript(process.env));
      });
    },
  };
}

export default defineConfig({
  plugins: [pagespaceConfig()],
  server: {
    // The environment's preview proxies port 8080; the preview reaches the dev
    // server under a host of the form env-<id>.preview.<apex>, which Vite
    // refuses unless told otherwise.
    port: 8080,
    host: true,
    allowedHosts: true,
  },
});
