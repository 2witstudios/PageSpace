/**
 * The real `StartLoopbackServer` implementation (Phase 4 task 3) — `node:http`
 * bound to `127.0.0.1` ONLY (RFC 8252 §7.3; never `0.0.0.0`, which would
 * expose the redirect endpoint beyond localhost) at an OS-assigned ephemeral
 * port (`listen(0, ...)`). Serves exactly one callback request, then the
 * caller closes it — this is a single-use, single-attempt server per login.
 */
import { createServer } from 'node:http';
import type { LoopbackCallback, LoopbackServer } from './loopback-flow.js';

export const LOOPBACK_HOST = '127.0.0.1';

/** The only path the OAuth redirect ever targets (see loopback-flow.ts's CALLBACK_PATH). */
const CALLBACK_PATH = '/callback';

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

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);

      // Browsers routinely fire off incidental requests (favicon, prefetch)
      // alongside the real OAuth redirect. This server serves exactly one
      // callback per login, so anything other than the redirect_uri's own
      // path must never touch pendingResolve/respond — otherwise it can
      // consume the single-use callback slot the real redirect needs.
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }

      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        // The OAuth callback query is attacker-influenceable; never let a query
        // key write to a prototype-polluting property (remote property injection).
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
        query[key] = value;
      });

      respond = (html: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}
