/**
 * The real `StartLoopbackServer` implementation (Phase 4 task 3) — `node:http`
 * bound to `127.0.0.1` ONLY (RFC 8252 §7.3; never `0.0.0.0`, which would
 * expose the redirect endpoint beyond localhost) at an OS-assigned ephemeral
 * port (`listen(0, ...)`). Serves exactly one callback request, then the
 * caller closes it — this is a single-use, single-attempt server per login.
 */
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { CALLBACK_PATH } from './loopback-flow.js';
import type { LoopbackCallback, LoopbackServer } from './loopback-flow.js';

export const LOOPBACK_HOST = '127.0.0.1';

export class PortBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortBindError';
  }
}

export function createLoopbackServer(): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    let pendingResolve: ((callback: LoopbackCallback) => void) | null = null;
    let respond: ((html: string) => void) | null = null;

    // Every socket the server accepts is tracked so close() can deterministically
    // clear connections that never reached a response — a TCP connection can be
    // opened (favicon prefetch, a stray probe) and simply never send request
    // bytes, in which case the 'request' event (and therefore the Connection:
    // close header below) never fires for it, and Node's default server.close()
    // would then wait on that socket forever. Sockets that DID reach a request
    // are left alone: their response always carries Connection: close, so Node
    // ends them itself once the write flushes — never truncating an in-flight
    // response.
    const sockets = new Set<Socket>();
    const respondedSockets = new WeakSet<Socket>();

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    server.on('request', (req, res) => {
      respondedSockets.add(req.socket);
      const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);

      // Browsers routinely fire off incidental requests (favicon, prefetch)
      // alongside the real OAuth redirect. This server serves exactly one
      // callback per login, so anything other than the redirect_uri's own
      // path must never touch pendingResolve/respond — otherwise it can
      // consume the single-use callback slot the real redirect needs.
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { Connection: 'close' }).end();
        return;
      }

      // The OAuth callback query is attacker-influenceable; never let a query
      // key write to a prototype-polluting property (remote property injection).
      // Object.fromEntries defines own data properties (CreateDataPropertyOrThrow),
      // it never mutates an object's prototype slot even for a "__proto__" key —
      // combined with the denylist filter this clears static analysis flags too.
      const DENIED_QUERY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
      const query: Record<string, string> = Object.fromEntries(
        [...url.searchParams.entries()].filter(([key]) => !DENIED_QUERY_KEYS.has(key)),
      );

      respond = (html: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end(html);
      };

      const deliver = pendingResolve;
      pendingResolve = null;
      deliver?.({ query });
    });

    server.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new PortBindError(error instanceof Error ? error.message : String(error)));
    });

    server.listen(0, LOOPBACK_HOST, () => {
      if (settled) return;
      const address = server.address();
      if (address === null || typeof address === 'string') {
        settled = true;
        reject(new PortBindError('Loopback server did not report a bound port.'));
        return;
      }
      settled = true;
      resolve({
        port: address.port,
        nextCallback(): Promise<LoopbackCallback> {
          return new Promise((res) => {
            pendingResolve = res;
          });
        },
        async finish(html: string): Promise<void> {
          respond?.(html);
        },
        close(): Promise<void> {
          for (const socket of sockets) {
            if (!respondedSockets.has(socket)) {
              socket.destroy();
            }
          }
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}
