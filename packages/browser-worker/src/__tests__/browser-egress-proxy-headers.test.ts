/**
 * The plaintext-http header allowlists of the egress proxy, driven end to
 * end over loopback sockets: a client request through a real proxy to a real
 * upstream server. No Chromium is involved — the proxy is addressed the way
 * Chromium addresses it, with an absolute-URI request line.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { assert } from './riteway.js';
import { startBrowserEgressProxy, type BrowserEgressProxy } from '../browser-egress-proxy-adapter.js';

const FAKE_PUBLIC = '93.184.216.34';

/** Every request header the proxy forwards, except the body-framing pair. */
const FORWARDED_REQUEST: Readonly<Record<string, string>> = {
  host: 'www.form.test',
  'user-agent': 'ua',
  accept: 'text/html',
  'accept-language': 'en',
  'accept-encoding': 'identity',
  'content-type': 'text/plain',
  cookie: 'a=1',
  referer: 'http://www.form.test/',
  origin: 'http://www.form.test',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'if-none-match': '"e"',
  'if-modified-since': 'Tue, 22 Sep 2026 00:00:00 GMT',
  range: 'bytes=0-',
  'upgrade-insecure-requests': '1',
  dnt: '1',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-user': '?1',
};

/** Headers a client can send that must never reach the site. */
const DROPPED_REQUEST: Readonly<Record<string, string>> = {
  'x-evil': 'client-chosen',
  'proxy-authorization': 'Basic c2VjcmV0',
  'proxy-connection': 'keep-alive',
  'x-forwarded-for': '10.0.0.1',
  authorization: 'Bearer leaked',
};

/** Every response header the proxy returns, except the body-framing pair. */
const FORWARDED_RESPONSE: Readonly<Record<string, string>> = {
  'content-type': 'text/plain',
  'content-encoding': 'identity',
  'content-language': 'en',
  'content-range': 'bytes 0-1/2',
  'accept-ranges': 'bytes',
  'cache-control': 'no-store',
  expires: '0',
  'last-modified': 'Tue, 22 Sep 2026 00:00:00 GMT',
  etag: '"e"',
  vary: 'accept',
  date: 'Tue, 22 Sep 2026 00:00:00 GMT',
  age: '0',
  location: '/next',
  refresh: '5',
  'retry-after': '1',
  'set-cookie': 'b=2',
  link: '</s.css>; rel=preload',
  'www-authenticate': 'Basic',
  'access-control-allow-origin': '*',
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods': 'GET',
  'access-control-allow-headers': 'x-a',
  'access-control-expose-headers': 'x-b',
  'access-control-max-age': '60',
  'content-security-policy': "default-src 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

/** Headers a site can send that must never reach the page. */
const DROPPED_RESPONSE: Readonly<Record<string, string>> = {
  'x-evil': 'site-chosen',
  server: 'upstream',
  'x-powered-by': 'upstream',
  'strict-transport-security': 'max-age=1',
};

/** Hop-by-hop headers each Node http endpoint adds for its own connection. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive']);

const withoutHopByHop = (headers: IncomingHttpHeaders): Record<string, unknown> =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)));

const expectedResponseHeaders = (): Record<string, unknown> => ({
  ...FORWARDED_RESPONSE,
  'set-cookie': [FORWARDED_RESPONSE['set-cookie']],
  'content-length': '2',
});

describe('the egress proxy on plaintext http', () => {
  let upstream: Server;
  let proxy: BrowserEgressProxy;
  let received: { headers: IncomingHttpHeaders; rawHeaders: string[] }[] = [];
  let upstreamStatus = 200;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      received.push({ headers: req.headers, rawHeaders: req.rawHeaders });
      req.resume();
      req.on('end', () => {
        for (const [name, value] of Object.entries({ ...FORWARDED_RESPONSE, ...DROPPED_RESPONSE })) res.setHeader(name, value);
        res.setHeader('content-length', '2');
        res.writeHead(upstreamStatus);
        res.end('ok');
      });
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const { port } = upstream.address() as AddressInfo;
    proxy = await startBrowserEgressProxy({
      allowedOrigins: null,
      resolve: async () => [FAKE_PUBLIC],
      dial: () => connect({ host: '127.0.0.1', port }),
    });
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((done) => upstream.close(() => done()));
  });

  const send = (headers: readonly string[], body?: string) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders }>((done, fail) => {
      const url = new URL(proxy.url);
      const req = httpRequest({ host: url.hostname, port: url.port, method: body === undefined ? 'GET' : 'POST', path: 'http://www.form.test/echo', headers: body === undefined ? [...headers] : [...headers, 'content-length', String(body.length)], agent: false }, (res) => {
        res.resume();
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers }));
      });
      req.on('error', fail);
      req.end(body);
    });

  const pairs = (record: Readonly<Record<string, string>>): string[] => Object.entries(record).flat();

  it('forwards exactly the allowlisted request headers and drops client-chosen names', async () => {
    received = [];
    await send([...pairs(FORWARDED_REQUEST), ...pairs(DROPPED_REQUEST)], 'hi');
    assert({
      given: 'a request carrying every allowlisted header plus x-evil, proxy credentials and forwarding headers',
      should: 'deliver only the allowlisted headers (with the body length) to the site',
      actual: withoutHopByHop(received[0]?.headers ?? {}),
      expected: { ...FORWARDED_REQUEST, 'content-length': '2' },
    });
  });

  it('delivers a single Host when the client sends two', async () => {
    received = [];
    await send(['host', 'www.form.test', 'host', 'evil.internal', 'accept', 'text/html']);
    const hosts = (received[0]?.rawHeaders ?? []).filter((_, index, raw) => index % 2 === 1 && raw[index - 1]?.toLowerCase() === 'host');
    assert({
      given: 'a request with a duplicate Host header',
      should: 'deliver exactly one Host, the first',
      actual: hosts,
      expected: ['www.form.test'],
    });
  });

  it('returns exactly the allowlisted response headers and drops site-chosen names', async () => {
    const response = await send(['host', 'www.form.test']);
    assert({
      given: 'a site answering with every allowlisted header plus x-evil, server, x-powered-by and HSTS',
      should: 'return only the allowlisted headers to the browser',
      actual: withoutHopByHop(response.headers),
      expected: expectedResponseHeaders(),
    });
  });

  it("returns the site's status code", async () => {
    upstreamStatus = 404;
    const response = await send(['host', 'www.form.test']);
    upstreamStatus = 200;
    assert({
      given: 'a site answering 404',
      should: 'return 404 to the browser',
      actual: response.status,
      expected: 404,
    });
  });
});

describe('the egress proxy given a status the site chose freely', () => {
  let upstream: NetServer;
  let proxy: BrowserEgressProxy;
  let statusLine = '';

  beforeAll(async () => {
    // A raw socket server: Node's own http server refuses to send these.
    upstream = createNetServer((socket) => {
      socket.once('data', () => socket.end(`HTTP/1.1 ${statusLine}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok`));
      socket.on('error', () => socket.destroy());
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const { port } = upstream.address() as AddressInfo;
    proxy = await startBrowserEgressProxy({
      allowedOrigins: null,
      resolve: async () => [FAKE_PUBLIC],
      dial: () => connect({ host: '127.0.0.1', port }),
    });
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((done) => upstream.close(() => done()));
  });

  const statusFor = (line: string) =>
    new Promise<number>((done, fail) => {
      statusLine = line;
      const url = new URL(proxy.url);
      const req = httpRequest({ host: url.hostname, port: url.port, path: 'http://www.form.test/', headers: { host: 'www.form.test' }, agent: false }, (res) => {
        res.resume();
        res.on('end', () => done(res.statusCode ?? 0));
      });
      req.on('error', fail);
      req.end();
    });

  it('passes a valid status through and turns an out-of-range or non-numeric one into 502', async () => {
    const actual = {
      ok: await statusFor('200 OK'),
      teapot: await statusFor('418 Teapot'),
      highest: await statusFor('599 Edge'),
      belowRange: await statusFor('099 Low'),
      aboveRange: await statusFor('600 High'),
      farAbove: await statusFor('999 Max'),
      nonNumeric: await statusFor('abc Nope'),
    };
    assert({
      given: 'sites answering 200, 418, 599, 099, 600, 999 and a non-numeric status',
      should: 'return the valid statuses and 502 for every other one',
      actual,
      expected: { ok: 200, teapot: 418, highest: 599, belowRange: 502, aboveRange: 502, farAbove: 502, nonNumeric: 502 },
    });
  });
});
