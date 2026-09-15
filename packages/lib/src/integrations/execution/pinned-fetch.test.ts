/**
 * Pinned fetch tests.
 *
 * The executor validates a target's DNS answer and must then connect to THAT
 * address — not re-resolve (DNS rebinding). These tests use a hostname under
 * `.invalid` (never resolvable) so a request only succeeds when the connection
 * really is pinned to the supplied address while the Host header keeps the
 * hostname.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pinnedFetch } from './pinned-fetch';

type Received = { host?: string; url?: string; method?: string; authorization?: string; body: string };

let server: http.Server;
let port: number;
let lastReceived: Received | null = null;
let mode: 'json' | 'no-content' | 'redirect' | 'hang' = 'json';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      lastReceived = {
        host: req.headers.host,
        url: req.url,
        method: req.method,
        authorization: req.headers.authorization,
        body,
      };
      if (mode === 'hang') return;
      if (mode === 'no-content') { res.writeHead(204); res.end(); return; }
      if (mode === 'redirect') { res.writeHead(302, { location: 'https://evil.example/collect' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('pinnedFetch', () => {
  it('given an unresolvable hostname and a pinned address, should connect to the address and keep the hostname in Host', async () => {
    mode = 'json';
    const response = await pinnedFetch(`http://pinned-host.invalid:${port}/hook?x=1`, {
      method: 'POST',
      headers: { Authorization: 'Bearer s3cret', 'Content-Type': 'application/json' },
      body: '{"a":1}',
      pinnedAddress: '127.0.0.1',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(lastReceived).toMatchObject({
      host: `pinned-host.invalid:${port}`,
      url: '/hook?x=1',
      method: 'POST',
      authorization: 'Bearer s3cret',
      body: '{"a":1}',
    });
  });

  it('given a 204 response, should return a body-less Response', async () => {
    mode = 'no-content';
    const response = await pinnedFetch(`http://pinned-host.invalid:${port}/hook`, { method: 'GET', pinnedAddress: '127.0.0.1' });
    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe('');
  });

  it('given a redirect response, should return it as-is and never follow', async () => {
    mode = 'redirect';
    const response = await pinnedFetch(`http://pinned-host.invalid:${port}/hook`, { method: 'GET', pinnedAddress: '127.0.0.1' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://evil.example/collect');
  });

  it('given an aborted signal while the upstream hangs, should reject with an AbortError', async () => {
    mode = 'hang';
    const controller = new AbortController();
    const pending = pinnedFetch(`http://pinned-host.invalid:${port}/hook`, {
      method: 'GET',
      pinnedAddress: '127.0.0.1',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('given no pinned address, should refuse rather than resolve the hostname itself', async () => {
    mode = 'json';
    await expect(
      pinnedFetch(`http://pinned-host.invalid:${port}/hook`, { method: 'GET', pinnedAddress: '' })
    ).rejects.toThrow(/pinned address/i);
  });
});
