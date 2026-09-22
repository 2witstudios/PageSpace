/**
 * The ONE place the two public values become a script: shared by the Vite dev
 * server (vite.config.ts) and the production server (server.mjs), so preview
 * and published read them the same way. Only these two names are ever read —
 * never the whole environment.
 */
export function pagespaceConfigScript(env) {
  const config = {
    PAGESPACE_URL: env.PAGESPACE_URL ?? '',
    PAGESPACE_CLIENT_ID: env.PAGESPACE_CLIENT_ID ?? '',
  };
  return `window.__PAGESPACE_ENV__ = ${JSON.stringify(config)};\n`;
}
