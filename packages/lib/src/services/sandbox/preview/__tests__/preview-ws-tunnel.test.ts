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
import { once } from 'node:events';
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
async function gateway(upstreamUrl: URL, onClose: (s: TunnelSummary) => void, opts: { handshakeTimeoutMs?: number } = {}) {
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

  it('answers 502 when the upstream cannot be reached at all', async () => {
    const dead = net.createServer();
    dead.listen(0, '127.0.0.1');
    await once(dead, 'listening');
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    let summary: TunnelSummary | undefined;
    const port = await gateway(new URL(`http://127.0.0.1:${deadPort}/`), (s) => { summary = s; });
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
  });
});
