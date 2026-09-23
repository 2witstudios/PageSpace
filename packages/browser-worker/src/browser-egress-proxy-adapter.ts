/**
 * The worker's egress proxy — the network boundary under the browser (S3
 * §3.5, R12/R13). Chromium is launched with `--proxy-server` pointing here
 * and `<-loopback>` removing the implicit localhost bypass, so EVERY
 * connection it opens arrives here first: `CONNECT host:port` for TLS
 * (https, wss) and absolute-URI requests for plaintext http.
 *
 * Adapter only (Control Board §7.1): each connection is decided by
 * `decideNavigation` and this file carries out the verdict. When the verdict
 * asks for resolution, the proxy resolves the name ONCE, decides again on
 * every address, and dials exactly the `connectAddress` the decision
 * returned — it never hands the name to the socket layer, so a rebinding
 * resolver gets no second answer to exploit.
 *
 * `resolve` and `dial` default to the real DNS and TCP stack. They are
 * parameters so the adapter's integration suite can route a public-looking
 * name to a loopback test server without weakening the decision itself.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Duplex } from 'node:stream';
import { decideNavigation, type NavigationDenyReason, type NavigationVerdict } from './decide-navigation.js';

export type EgressRefusal = {
  readonly url: string;
  readonly reason: NavigationDenyReason | 'unsupported-request';
};

export type BrowserEgressProxyOptions = {
  readonly allowedOrigins: readonly string[] | null;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly dial?: (address: string, port: number) => Socket;
  readonly onRefused?: (refusal: EgressRefusal) => void;
};

export type BrowserEgressProxy = {
  /** `http://127.0.0.1:<port>`, for Chromium's `--proxy-server`. */
  readonly url: string;
  /** Total refusals since start. */
  readonly refusalCount: () => number;
  /** The most recent refusals, at most {@link RECENT_REFUSALS_KEPT}. */
  readonly refusals: () => readonly EgressRefusal[];
  readonly close: () => Promise<void>;
};

/**
 * The request headers forwarded on plaintext http. An allowlist, so the proxy
 * hop's own headers (Proxy-Authorization, Proxy-Connection, Connection, …)
 * and anything unusual stay behind. TLS traffic is a CONNECT tunnel and is
 * not touched by this list.
 */
const FORWARDED_REQUEST_HEADERS: readonly string[] = Object.freeze([
  'host',
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'content-type',
  'content-length',
  'transfer-encoding',
  'cookie',
  'referer',
  'origin',
  'cache-control',
  'pragma',
  'if-none-match',
  'if-modified-since',
  'range',
  'upgrade-insecure-requests',
  'dnt',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
]);

/**
 * The response headers returned on plaintext http — the standard semantics a
 * page needs (type, length, encoding, caching, redirects, cookies, CORS and
 * the security policies), by fixed name. Plaintext is the minority path: TLS
 * responses travel inside the CONNECT tunnel untouched.
 */
const FORWARDED_RESPONSE_HEADERS: readonly string[] = Object.freeze([
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-range',
  'transfer-encoding',
  'accept-ranges',
  'cache-control',
  'expires',
  'last-modified',
  'etag',
  'vary',
  'date',
  'age',
  'location',
  'refresh',
  'retry-after',
  'set-cookie',
  'link',
  'www-authenticate',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
]);

/** A page can loop refused requests forever; only a bounded tail is kept. */
export const RECENT_REFUSALS_KEPT = 100;

const defaultResolve = async (host: string): Promise<readonly string[]> => {
  try {
    return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  } catch {
    return [];
  }
};

const defaultDial = (address: string, port: number): Socket => netConnect({ host: address, port });

/** How long one checked address gets before the next is tried. */
const DIAL_ATTEMPT_TIMEOUT_MS = 5_000;

export const startBrowserEgressProxy = async ({
  allowedOrigins,
  resolve = defaultResolve,
  dial = defaultDial,
  onRefused,
}: BrowserEgressProxyOptions): Promise<BrowserEgressProxy> => {
  const refusals: EgressRefusal[] = [];
  let refusalCount = 0;
  // CONNECT tunnels are hijacked sockets the http server no longer tracks.
  const tunnels = new Set<Duplex>();

  const refuse = (url: string, reason: EgressRefusal['reason']): void => {
    const refusal = { url, reason };
    refusalCount += 1;
    refusals.push(refusal);
    if (refusals.length > RECENT_REFUSALS_KEPT) refusals.shift();
    onRefused?.(refusal);
  };

  /**
   * The first checked address that connects, in order, or `null`. Only
   * addresses the decision already checked are ever tried, so falling back
   * never widens the policy; it keeps a dual-stack site reachable from a
   * substrate with one address family.
   */
  const dialChecked = async (addresses: readonly string[], port: number): Promise<Socket | null> => {
    for (const address of addresses) {
      const socket = dial(address, port);
      const connected = await new Promise<boolean>((done) => {
        const timer = setTimeout(() => done(false), DIAL_ATTEMPT_TIMEOUT_MS);
        timer.unref();
        socket.once('connect', () => {
          clearTimeout(timer);
          done(true);
        });
        socket.once('error', () => {
          clearTimeout(timer);
          done(false);
        });
      });
      if (connected) return socket;
      socket.destroy();
    }
    return null;
  };

  const decide = async (url: string): Promise<NavigationVerdict> => {
    const first = decideNavigation({ url, resolvedAddresses: null, allowedOrigins });
    if (first.verdict !== 'resolve') return first;
    return decideNavigation({ url, resolvedAddresses: await resolve(first.host), allowedOrigins });
  };

  const onConnect = async (req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> => {
    // Node stops handling errors on a socket once it is handed to 'connect'.
    // Attach first: a reset during the lookup must not crash the worker.
    client.on('error', () => client.destroy());
    const target = req.url ?? '';
    const url = `https://${target}/`;
    const verdict = await decide(url);
    if (client.destroyed) return;
    if (verdict.verdict !== 'allow') {
      refuse(url, verdict.verdict === 'deny' ? verdict.reason : 'unresolved');
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    tunnels.add(client);
    client.once('close', () => tunnels.delete(client));
    const upstream = await dialChecked(verdict.connectAddresses, verdict.transportOrigin.port);
    if (upstream === null || client.destroyed) {
      upstream?.destroy();
      client.destroy();
      return;
    }
    tunnels.add(upstream);
    upstream.once('close', () => tunnels.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.once('close', () => upstream.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  };

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? '';
    if (!url.startsWith('http://')) {
      refuse(url, 'unsupported-request');
      res.writeHead(400).end();
      return;
    }
    const verdict = await decide(url);
    if (verdict.verdict !== 'allow') {
      refuse(url, verdict.verdict === 'deny' ? verdict.reason : 'unresolved');
      // Fail the connection rather than answer: a proxy's 403 page over
      // plaintext would render as the site's own content, and the browser
      // would report a successful navigation to a refused destination.
      req.socket.destroy();
      return;
    }
    const socket = await dialChecked(verdict.connectAddresses, verdict.transportOrigin.port);
    if (socket === null) {
      res.writeHead(502).end();
      return;
    }
    // The upstream socket is `dial(connectAddress)` — the address the
    // decision checked — so the request URL carries only the path; its
    // origin is a placeholder no DNS lookup or connection ever uses. The
    // client's Host header travels in `headers` and is what the site sees.
    const requested = new URL(url);
    const target = new URL('http://upstream.invalid/');
    target.pathname = requested.pathname;
    target.search = requested.search;
    // Only the request headers a browser needs, by FIXED name — never a name
    // the client chose, and never the proxy hop's own headers.
    const headers: Record<string, string | string[]> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    const upstream = httpRequest(target, {
      method: req.method,
      headers,
      createConnection: () => socket,
    });
    upstream.on('response', (response) => {
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = response.headers[name];
        if (value !== undefined) res.setHeader(name, value);
      }
      // The upstream chooses its status, so only a valid HTTP status passes;
      // anything else is the proxy's 502. Node's parser admits any three
      // digits, and sending the head throws on a status below 100. The status
      // is set on `res.statusCode` and the head flushed now, so a reset after
      // the site's head still reaches the browser as the site's status: CodeQL
      // alert 350 flagged the unchecked upstream status flowing into
      // `writeHead`.
      const status = response.statusCode;
      const valid = status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599;
      res.statusCode = valid ? status : 502;
      res.flushHeaders();
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  };

  const server = createServer((req, res) => void onRequest(req, res));
  server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => void onConnect(req, socket, head));
  // A WebSocket upgrade sent as an absolute-URI request (Chromium tunnels
  // ws:// through CONNECT instead) is not a shape this proxy decides: refuse.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    refuse(req.url ?? '', 'unsupported-request');
    socket.destroy();
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    refusalCount: () => refusalCount,
    refusals: () => [...refusals],
    close: () =>
      new Promise<void>((done) => {
        tunnels.forEach((socket) => socket.destroy());
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
};
