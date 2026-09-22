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
  readonly refusals: () => readonly EgressRefusal[];
  readonly close: () => Promise<void>;
};

/** Headers that address the proxy hop itself and must not travel upstream. */
const HOP_HEADERS = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']);

const defaultResolve = async (host: string): Promise<readonly string[]> => {
  try {
    return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  } catch {
    return [];
  }
};

const defaultDial = (address: string, port: number): Socket => netConnect({ host: address, port });

export const startBrowserEgressProxy = async ({
  allowedOrigins,
  resolve = defaultResolve,
  dial = defaultDial,
  onRefused,
}: BrowserEgressProxyOptions): Promise<BrowserEgressProxy> => {
  const refusals: EgressRefusal[] = [];
  // CONNECT tunnels are hijacked sockets the http server no longer tracks.
  const tunnels = new Set<Duplex>();

  const refuse = (url: string, reason: EgressRefusal['reason']): void => {
    const refusal = { url, reason };
    refusals.push(refusal);
    onRefused?.(refusal);
  };

  const decide = async (url: string): Promise<NavigationVerdict> => {
    const first = decideNavigation({ url, resolvedAddresses: null, allowedOrigins });
    if (first.verdict !== 'resolve') return first;
    return decideNavigation({ url, resolvedAddresses: await resolve(first.host), allowedOrigins });
  };

  const onConnect = async (req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> => {
    const target = req.url ?? '';
    const url = `https://${target}/`;
    const verdict = await decide(url);
    if (verdict.verdict !== 'allow') {
      refuse(url, verdict.verdict === 'deny' ? verdict.reason : 'unresolved');
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = dial(verdict.connectAddress, verdict.transportOrigin.port);
    tunnels.add(client);
    tunnels.add(upstream);
    client.once('close', () => tunnels.delete(client));
    upstream.once('close', () => tunnels.delete(upstream));
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
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
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())));
    const { connectAddress, transportOrigin } = verdict;
    const upstream = httpRequest(url, {
      method: req.method,
      headers,
      createConnection: () => dial(connectAddress, transportOrigin.port),
    });
    upstream.on('response', (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
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
    refusals: () => [...refusals],
    close: () =>
      new Promise<void>((done) => {
        tunnels.forEach((socket) => socket.destroy());
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
};
