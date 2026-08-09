/**
 * Same-origin reverse proxy for the e2e live-delivery specs.
 *
 * WHY THIS EXISTS (do not replace it with "just point NEXT_PUBLIC_REALTIME_URL at :3001"):
 * the shipped CSP is `connect-src 'self' ws: wss:` (apps/web/src/middleware/security-headers.ts)
 * and Socket.IO opens with an XHR POLLING handshake before it upgrades. A cross-origin realtime
 * server therefore gets that handshake blocked by CSP and NO socket connects at all — silently.
 * The live-delivery specs then still pass, for the WRONG reason, off the mount-time refetch.
 *
 * Production does not hit this because Traefik path-routes `/socket.io` to the realtime service
 * on the app's own host (infrastructure/docker-compose.tenant.yml), which `'self'` covers. This
 * script is that Traefik rule, in ~80 lines with no dependencies: one listening port that
 * forwards `/socket.io` (including the websocket upgrade) to realtime and everything else to
 * web, so the browser only ever sees one origin and `NEXT_PUBLIC_REALTIME_URL` stays UNSET.
 *
 * Used by the `e2e` job in .github/workflows/ci.yml and by anyone reproducing the specs locally
 * (see the header of tests/16-dispatch-multiplayer.spec.ts).
 *
 *   E2E_PROXY_PORT=3000 E2E_WEB_TARGET=http://127.0.0.1:3100 \
 *   E2E_REALTIME_TARGET=http://127.0.0.1:3001 bun run support/e2e-proxy.ts
 */
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.E2E_PROXY_PORT ?? 3000);
const WEB = new URL(process.env.E2E_WEB_TARGET ?? 'http://127.0.0.1:3100');
const REALTIME = new URL(process.env.E2E_REALTIME_TARGET ?? 'http://127.0.0.1:3001');

/** The one path Traefik splits on. Everything else is the app. */
const isRealtimePath = (url: string | undefined): boolean => (url ?? '/').startsWith('/socket.io');

const targetFor = (url: string | undefined): URL => (isRealtimePath(url) ? REALTIME : WEB);

const server = http.createServer((req, res) => {
  const target = targetFor(req.url);
  const proxied = http.request(
    {
      host: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      // Forwarded verbatim. The app reads Origin/Cookie/X-Browser-Session-Id off these and
      // rewriting Host would make the app generate absolute URLs pointing at the backend port.
      headers: req.headers,
      // No connection pooling. Socket.IO's polling transport parks a GET open until the server
      // has something to push; through a pooled keep-alive agent that held-open response can
      // sit in the agent's buffer instead of reaching the browser, which delivers a socket that
      // joins rooms fine (client→server POSTs work) but never receives anything. That failure
      // looks exactly like a broken feature, so take the dedicated-socket path.
      agent: false,
    },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      // Push each chunk out as it arrives rather than letting Node coalesce it — a long-poll
      // response is one small chunk that must not wait for more.
      res.flushHeaders();
      upstream.on('data', (chunk) => {
        res.write(chunk);
      });
      upstream.on('end', () => res.end());
    }
  );
  proxied.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`e2e-proxy: upstream error for ${req.url}: ${err.message}`);
  });
  req.pipe(proxied, { end: true });
});

/**
 * The websocket upgrade. Socket.IO polls first and upgrades second, so a proxy that only
 * handles `request` produces a socket that connects and then dies on upgrade — which looks
 * exactly like the CSP failure this whole file exists to avoid. Raw-pipe both directions.
 */
server.on('upgrade', (req, socket, head) => {
  const target = targetFor(req.url);
  const upstream = net.connect(Number(target.port), target.hostname, () => {
    const headerLines = Object.entries(req.headers).flatMap(([key, value]) =>
      Array.isArray(value) ? value.map((v) => `${key}: ${v}`) : [`${key}: ${value}`]
    );
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`
    );
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const destroy = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on('error', destroy);
  socket.on('error', destroy);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[e2e-proxy] :${PORT} -> web ${WEB.origin} | /socket.io -> realtime ${REALTIME.origin}`
  );
});
