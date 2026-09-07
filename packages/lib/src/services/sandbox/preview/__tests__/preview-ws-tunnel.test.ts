/**
 * The tunnel against REAL sockets: a local "sprite" HTTP server that
 * upgrades (or refuses), a local "client" that speaks the WebSocket
 * handshake by hand, and the tunnel in between. No `ws` dependency — the
 * tunnel is byte-transparent, so a hand-rolled handshake plus raw bytes
 * proves exactly what it must: the 101 and its allowlisted headers are
 * relayed, the client's cookie never reaches the sprite, the org token does,
 * bytes flow both ways, and a non-101 becomes a plain HTTP error.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { formatSocketHttpError, formatUpgradeResponse, tunnelWebSocketUpgrade, type TunnelSummary } from '../preview-ws-tunnel';

const servers: Array<http.Server | net.Server> = [];
const sockets = new Set<net.Socket>();
function track(server: http.Server | net.Server): void {
  server.on('connection', (socket: net.Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  servers.push(server);
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A fake sprite: records the upgrade request it saw, answers 101 and echoes bytes back upper-cased. */
async function fakeSprite(mode: 'upgrade' | 'reject' | 'hang' = 'upgrade') {
  const seen: { headers: http.IncomingHttpHeaders; url?: string }[] = [];
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    seen.push({ headers: req.headers, url: req.url });
    if (mode === 'hang') return;
    if (mode === 'reject') {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: acc\r\nSet-Cookie: leak=1\r\nX-Dev: yes\r\n\r\n');
    if (head.length) socket.write(Buffer.from(head.toString().toUpperCase()));
    socket.on('data', (chunk: Buffer) => socket.write(Buffer.from(chunk.toString().toUpperCase())));
  });
  track(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { seen, url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`) };
}

/** A gateway that hands every upgrade on its socket to the tunnel — the realtime app's role. */
async function gateway(
  upstreamUrl: URL,
  onClose: (s: TunnelSummary) => void,
  opts: Partial<Pick<Parameters<typeof tunnelWebSocketUpgrade>[0], 'handshakeTimeoutMs' | 'request'>> = {},
) {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    const requestHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') requestHeaders[k] = v;
    tunnelWebSocketUpgrade({
      clientSocket: socket,
      head,
      requestHeaders,
      upstreamUrl: new URL(`${req.url ?? '/'}`, upstreamUrl),
      token: 'org-token',
      onClose,
      ...opts,
    });
  });
  track(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/** A hand-rolled client: sends an upgrade request and collects raw bytes. */
async function client(port: number, path: string, extraHeaders: string[] = []) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const chunks: Buffer[] = [];
  socket.on('data', (c: Buffer) => chunks.push(c));
  socket.write([`GET ${path} HTTP/1.1`, `Host: env-1.preview.example`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Key: key123', 'Sec-WebSocket-Version: 13', 'Cookie: __Host-ps_preview=secret', ...extraHeaders, '', ''].join('\r\n'));
  const text = () => Buffer.concat(chunks).toString();
  const waitFor = (needle: string) => new Promise<void>((resolve, reject) => {
    const check = () => { if (text().includes(needle)) { socket.off('data', check); resolve(); } };
    socket.on('data', check);
    socket.on('close', () => reject(new Error(`closed before "${needle}" in: ${text()}`)));
    check();
  });
  return { socket, text, waitFor };
}

describe('tunnelWebSocketUpgrade', () => {
  it('relays a 101 with allowlisted headers, forwards handshake + org token (never the cookie), and pipes bytes both ways', async () => {
    const sprite = await fakeSprite();
    let summary: TunnelSummary | undefined;
    const port = await gateway(sprite.url, (s) => { summary = s; });
    const c = await client(port, '/ws?token=x');
    await c.waitFor('\r\n\r\n');
    const response = c.text();
    expect(response.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true);
    expect(response).toMatch(/sec-websocket-accept: acc/i);
    expect(response).toMatch(/x-dev: yes/i);
    expect(response).not.toMatch(/set-cookie/i);

    const upstream = sprite.seen[0];
    expect(upstream.url).toBe('/ws?token=x');
    expect(upstream.headers.authorization).toBe('Bearer org-token');
    expect(upstream.headers['sec-websocket-key']).toBe('key123');
    expect(upstream.headers.cookie).toBeUndefined();
    expect(upstream.headers.host).toBe(sprite.url.host);

    c.socket.write('hello');
    await c.waitFor('HELLO');
    const closed = new Promise<void>((resolve) => { const tick = () => (summary ? resolve() : setTimeout(tick, 10)); tick(); });
    c.socket.destroy();
    await closed;
    expect(summary?.outcome).toBe('established');
    expect(summary?.bytesToUpstream).toBe(5);
    expect(summary?.bytesToClient).toBe(5);
  });

  it('turns a refused upgrade into a plain HTTP error for the client and never relays a body', async () => {
    const sprite = await fakeSprite('reject');
    let summary: TunnelSummary | undefined;
    const port = await gateway(sprite.url, (s) => { summary = s; });
    const c = await client(port, '/');
    await once(c.socket, 'close');
    expect(c.text().startsWith('HTTP/1.1 403 Upgrade Refused\r\n')).toBe(true);
    expect(summary).toMatchObject({ outcome: 'upstream-rejected', upstreamStatus: 403 });
  });

  /**
   * "Cannot be reached" is driven by a server that OWNS its port for the whole
   * test and drops every connection, rather than by connecting to a port we
   * closed a moment ago.
   *
   * The closed-port version was a real flake and it cost master a red build
   * (Security Tests on 8a02fef5, 2026-09-07; the identical commit passed on a
   * re-run). Closing a listener does not RESERVE its port: between the close
   * and the tunnel's connect, any other process on the runner — and CI runs
   * several workspaces' suites at once, all binding port 0 — can be handed
   * that exact ephemeral port. When that happens the connection is ACCEPTED,
   * so the tunnel waits out its handshake bound, which defaults to
   * `PREVIEW_PROXY_LIMITS.upstreamHeadersTimeoutMs` (60s), and vitest kills
   * the test at 5s. That is why the failure was an opaque
   * "Test timed out in 5000ms" with no assertion — the tell that the socket
   * neither connected-and-failed nor was refused.
   *
   * A port cannot be reserved as "unbound", so the race cannot be closed while
   * the test depends on nothing listening. Holding the port and dropping the
   * connection instead is deterministic, and it exercises the SAME branch: the
   * tunnel has one `req.on('error')` handler, and both ECONNREFUSED and a
   * connection dropped before any response land in it as 502 / `upstream-error`.
   * The literal refused errno is pinned separately, below, through the
   * injectable `request` seam.
   */
  it('answers 502 when the upstream cannot be reached at all', async () => {
    const unreachable = net.createServer((socket) => socket.destroy());
    track(unreachable);
    unreachable.listen(0, '127.0.0.1');
    await once(unreachable, 'listening');
    const deadPort = (unreachable.address() as AddressInfo).port;

    let summary: TunnelSummary | undefined;
    const port = await gateway(new URL(`http://127.0.0.1:${deadPort}/`), (s) => { summary = s; });
    const c = await client(port, '/');
    await once(c.socket, 'close');
    expect(c.text().startsWith('HTTP/1.1 502 Bad Gateway\r\n')).toBe(true);
    expect(summary?.outcome).toBe('upstream-error');
  });

  /**
   * The literal ECONNREFUSED path, pinned without a socket at all. This file
   * deliberately works against REAL sockets (see the header), and the case
   * above keeps doing so; this one exists because the one thing real sockets
   * cannot give us deterministically is "nothing is listening here".
   */
  it('answers 502 when the connection is REFUSED outright', async () => {
    let summary: TunnelSummary | undefined;
    const port = await gateway(new URL('http://127.0.0.1:9/'), (s) => { summary = s; }, {
      // A `ClientRequest` double: the tunnel only ever calls `on`, `end` and
      // `destroy` on it (nothing else is reachable before a response), so the
      // double is complete for this path rather than a partial stand-in.
      request: () => {
        const req = Object.assign(new EventEmitter(), { end: () => {}, destroy: () => {} });
        setImmediate(() => req.emit('error', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })));
        return req as unknown as http.ClientRequest;
      },
    });
    const c = await client(port, '/');
    await once(c.socket, 'close');
    expect(c.text().startsWith('HTTP/1.1 502 Bad Gateway\r\n')).toBe(true);
    expect(summary?.outcome).toBe('upstream-error');
  });

  it('answers 504 when the upstream never completes the handshake within the bound', async () => {
    const sprite = await fakeSprite('hang');
    let summary: TunnelSummary | undefined;
    const port = await gateway(sprite.url, (s) => { summary = s; }, { handshakeTimeoutMs: 50 });
    const c = await client(port, '/');
    await once(c.socket, 'close');
    expect(c.text().startsWith('HTTP/1.1 504 Gateway Timeout\r\n')).toBe(true);
    expect(summary?.outcome).toBe('handshake-timeout');
  });

  it('formats socket-level responses without a body', () => {
    expect(formatSocketHttpError(502, 'Bad Gateway')).toBe('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    expect(formatUpgradeResponse({ 'sec-websocket-accept': 'a' })).toBe('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nsec-websocket-accept: a\r\n\r\n');
    expect(formatUpgradeResponse({ 'x-dev': 'a\r\nset-cookie: injected' })).toBe('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nx-dev: aset-cookie: injected\r\n\r\n');
  });
});
