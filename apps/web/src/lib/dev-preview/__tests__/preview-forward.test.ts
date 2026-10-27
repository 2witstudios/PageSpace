// @vitest-environment node
/**
 * The HTTP forwarder against a REAL local upstream (a fake sprite over
 * `http://127.0.0.1`), driven through an injected `fetch` that re-homes the
 * https sprite origin onto the local server — so the policy's "only a
 * sprite URL" check still runs on the real URL while bytes hit a real socket.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { forwardPreviewRequest } from '../preview-forward';
import { PREVIEW_PROXY_LIMITS } from '@pagespace/lib/services/sandbox/preview/preview-proxy-policy';

const SPRITE = 'https://ps-abc-org.sprites.app';
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function upstream(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    return fetch(`${base}${url.pathname}${url.search}`, init);
  };
  return { fetchImpl };
}

describe('forwardPreviewRequest', () => {
  it('forwards the path+query with the org token and only allowlisted headers; relays status, safe headers, and the body', async () => {
    let seen: http.IncomingMessage | undefined;
    const { fetchImpl } = await upstream((req, res) => {
      seen = req;
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': ['sid=1; Domain=preview.example; Path=/', '__Host-ps_preview=forged'],
        'x-frame-options': 'DENY',
        'content-security-policy': "img-src 'self'",
        'strict-transport-security': 'max-age=1',
      });
      res.end('<h1>hi</h1>');
    });
    const request = new Request('https://env-e1.preview.example/src/main.tsx?import', {
      headers: { cookie: '__Host-ps_preview=secret', authorization: 'Bearer client', accept: 'text/html', origin: 'https://app', 'accept-encoding': 'gzip' },
    });
    const outcome = await forwardPreviewRequest({ request, pathAndQuery: '/src/main.tsx?import', spriteUrl: SPRITE, token: 'org', appOrigin: 'https://app.pagespace.ai', fetchImpl });
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;

    expect(seen?.url).toBe('/src/main.tsx?import');
    expect(seen?.headers.authorization).toBe('Bearer org');
    expect(seen?.headers.cookie).toBeUndefined();
    expect(seen?.headers.origin).toBeUndefined();
    expect(seen?.headers['accept-encoding']).toBe('identity');
    expect(seen?.headers.accept).toBe('text/html');

    const { response } = outcome;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>hi</h1>');
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('x-frame-options')).toBeNull();
    expect(response.headers.get('strict-transport-security')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual(['sid=1; Path=/']);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain('frame-ancestors https://app.pagespace.ai');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps a dev-server redirect on the preview host by making a sprite-origin Location relative', async () => {
    const { fetchImpl } = await upstream((_req, res) => { res.writeHead(302, { location: `${SPRITE}/login?next=%2F` }); res.end(); });
    const outcome = await forwardPreviewRequest({ request: new Request('https://x/'), pathAndQuery: '/', spriteUrl: SPRITE, token: 't', appOrigin: null, fetchImpl });
    expect(outcome.kind === 'response' && outcome.response.status).toBe(302);
    expect(outcome.kind === 'response' && outcome.response.headers.get('location')).toBe('/login?next=%2F');
    expect(outcome.kind === 'response' && outcome.response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });

  it('streams a request body up and refuses one that declares itself over the cap without contacting upstream', async () => {
    let body = '';
    let hits = 0;
    const { fetchImpl } = await upstream((req, res) => { hits += 1; req.on('data', (c: Buffer) => { body += c.toString(); }); req.on('end', () => { res.writeHead(201); res.end('ok'); }); });
    const post = new Request('https://x/api', { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } });
    const ok = await forwardPreviewRequest({ request: post, pathAndQuery: '/api', spriteUrl: SPRITE, token: 't', appOrigin: null, fetchImpl });
    expect(ok.kind === 'response' && ok.response.status).toBe(201);
    expect(body).toBe('payload');

    const huge = new Request('https://x/api', { method: 'POST', body: 'x', headers: { 'content-length': String(PREVIEW_PROXY_LIMITS.maxRequestBodyBytes + 1) } });
    const refused = await forwardPreviewRequest({ request: huge, pathAndQuery: '/api', spriteUrl: SPRITE, token: 't', appOrigin: null, fetchImpl });
    expect(refused).toEqual({ kind: 'refused', status: 413, reason: 'request-too-large' });
    expect(hits).toBe(1);
  });

  it('cuts a response that exceeds the byte cap', async () => {
    const { fetchImpl } = await upstream((_req, res) => { res.writeHead(200); res.end(Buffer.alloc(2048, 1)); });
    const limits = Object.freeze({ ...PREVIEW_PROXY_LIMITS, maxResponseBodyBytes: 1024 });
    const outcome = await forwardPreviewRequest({ request: new Request('https://x/big'), pathAndQuery: '/big', spriteUrl: SPRITE, token: 't', appOrigin: null, fetchImpl, limits });
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    await expect(outcome.response.arrayBuffer()).rejects.toThrow(/byte limit/);
  });

  it('measures the headers deadline from the last uploaded byte — a slow streaming upload is not cut by it', async () => {
    let received = '';
    const { fetchImpl } = await upstream((req, res) => { req.on('data', (c: Buffer) => { received += c.toString(); }); req.on('end', () => { res.writeHead(201); res.end('ok'); }); });
    const limits = Object.freeze({ ...PREVIEW_PROXY_LIMITS, upstreamHeadersTimeoutMs: 120 });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 4; i += 1) {
          await new Promise((r) => setTimeout(r, 60));
          controller.enqueue(new TextEncoder().encode(`chunk${i}`));
        }
        controller.close();
      },
    });
    const post = new Request('https://x/upload', { method: 'POST', body, headers: { 'content-type': 'text/plain' }, duplex: 'half' } as RequestInit);
    const outcome = await forwardPreviewRequest({ request: post, pathAndQuery: '/upload', spriteUrl: SPRITE, token: 't', appOrigin: null, fetchImpl, limits });
    expect(outcome.kind === 'response' && outcome.response.status).toBe(201);
    expect(received).toBe('chunk0chunk1chunk2chunk3');
  });

  it('answers 504 when the upstream never sends headers within the bound, and 502 when it cannot be reached', async () => {
    const { fetchImpl } = await upstream(() => { /* never answers */ });
    const limits = Object.freeze({ ...PREVIEW_PROXY_LIMITS, upstreamHeadersTimeoutMs: 50 });
    const slow = await forwardPreviewRequest({ request: new Request('https://x/'), pathAndQuery: '/', spriteUrl: SPRITE, token: 't', appOrigin: null, fetchImpl, limits });
    expect(slow).toMatchObject({ kind: 'upstream-error', status: 504 });

    const dead: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const unreachable = await forwardPreviewRequest({ request: new Request('https://x/'), pathAndQuery: '/', spriteUrl: SPRITE, token: 't', appOrigin: null, fetchImpl: dead });
    expect(unreachable).toMatchObject({ kind: 'upstream-error', status: 502, reason: 'fetch failed' });
  });

  it('refuses to forward to anything but a sprite URL, before any request is made', async () => {
    const dead: typeof fetch = () => Promise.reject(new Error('must not be called'));
    await expect(forwardPreviewRequest({ request: new Request('https://x/'), pathAndQuery: '/', spriteUrl: 'https://evil.example.com', token: 't', appOrigin: null, fetchImpl: dead })).rejects.toThrow(/refusing to forward/);
  });

  it('HEAD relays headers with no body', async () => {
    const { fetchImpl } = await upstream((_req, res) => { res.writeHead(200, { 'content-type': 'text/css' }); res.end(); });
    const outcome = await forwardPreviewRequest({ request: new Request('https://x/a.css', { method: 'HEAD' }), pathAndQuery: '/a.css', spriteUrl: SPRITE, token: 't', appOrigin: null, fetchImpl });
    expect(outcome.kind === 'response' && outcome.response.body).toBeNull();
    expect(outcome.kind === 'response' && outcome.response.headers.get('content-type')).toBe('text/css');
  });
});
