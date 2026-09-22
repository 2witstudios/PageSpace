/**
 * Production server: static files from dist/, /pagespace-config.js from the
 * process environment, and index.html for every other path — which is what
 * makes /auth/pagespace/callback render the app. No dependencies. Listens on
 * PORT (the published machine sets it).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagespaceConfigScript } from './pagespace-config.mjs';

const dist = fileURLToPath(new URL('./dist/', import.meta.url));
const port = Number(process.env.PORT ?? 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/pagespace-config.js') {
    res.writeHead(200, { 'content-type': types['.js'], 'cache-control': 'no-store' });
    res.end(pagespaceConfigScript(process.env));
    return;
  }
  const candidate = normalize(join(dist, pathname));
  const file = candidate.startsWith(dist) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(dist, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`listening on ${port}`);
});
