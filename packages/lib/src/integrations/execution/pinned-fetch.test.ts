/**
 * Pinned fetch tests.
 *
 * The executor validates a target's DNS answer and must then connect to THAT
 * address — not re-resolve (DNS rebinding). These tests use a hostname under
 * `.invalid` (never resolvable) so a request only succeeds when the connection
 * really is pinned to the supplied address while the Host header keeps the
 * hostname.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import net, { type AddressInfo } from 'node:net';
import { pinnedFetch, DEFAULT_USER_AGENT } from './pinned-fetch';

type Received = {
  host?: string;
  url?: string;
  method?: string;
  authorization?: string;
  userAgent?: string;
  contentLength?: string;
  transferEncoding?: string;
  body: string;
};

let server: http.Server;
let port: number;
let lastReceived: Received | null = null;
let mode: 'json' | 'no-content' | 'redirect' | 'hang' | 'encoded' = 'json';
let encoding = '';
const ENCODED_PAYLOAD = { ok: true, items: ['a', 'b'] };

/** Apply each listed coding in order, as a server does for `Content-Encoding: a, b`. */
const encodeBody = (codings: string, raw: Buffer): Buffer =>
  codings
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .reduce((buf, coding) => {
      if (coding === 'gzip' || coding === 'x-gzip') return zlib.gzipSync(buf);
      if (coding === 'deflate') return zlib.deflateSync(buf);
      if (coding === 'br') return zlib.brotliCompressSync(buf);
      return buf;
    }, raw);

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
        userAgent: req.headers['user-agent'],
        contentLength: req.headers['content-length'],
        transferEncoding: req.headers['transfer-encoding'],
        body,
      };
      if (mode === 'hang') return;
      if (mode === 'no-content') { res.writeHead(204); res.end(); return; }
      if (mode === 'encoded') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding });
        res.end(encodeBody(encoding, Buffer.from(JSON.stringify(ENCODED_PAYLOAD))));
        return;
      }
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
  it('given an https URL whose host is an IPv6 literal, should hand node:https the bare address so the certificate is checked against it', async () => {
    // With the brackets kept, TLS compares the certificate against "[::1]" and
    // always fails (ERR_TLS_CERT_ALTNAME_INVALID); verified against a real
    // loopback certificate outside the suite.
    const requestSpy = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('captured');
    });
    try {
      await pinnedFetch('https://[::1]:8443/hook', { method: 'GET', pinnedAddresses: ['::1'] }).catch(() => undefined);
      const options = requestSpy.mock.calls[0]?.[0] as { hostname?: string; servername?: string } | undefined;

      const actual = { hostname: options?.hostname, servername: options?.servername };
      const expected = { hostname: '::1', servername: undefined };
      expect(actual).toEqual(expected);
    } finally {
      requestSpy.mockRestore();
    }
  });

  it.each([
    ['a HEAD response', 'HEAD', 'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 1234\r\n\r\n'],
    ['an empty GET body', 'GET', 'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n'],
  ])('given %s labelled gzip, should read as an empty body rather than a decode error (as fetch does)', async (_label, method, reply) => {
    const raw = net.createServer((socket) => {
      socket.on('error', () => undefined); // the client may reset the connection
      socket.once('data', () => socket.end(reply));
    });
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
    const rawPort = (raw.address() as AddressInfo).port;
    try {
      const response = await pinnedFetch(`http://pinned-host.invalid:${rawPort}/hook`, {
        method,
        pinnedAddresses: ['127.0.0.1'],
      });
      const actual = await response.text().catch((error: Error) => `error: ${error.message}`);
      const expected = '';
      expect(actual).toEqual(expected);
    } finally {
      raw.close();
    }
  });

  it('given a status line whose reason phrase has a control character, should still return the response (as fetch does)', async () => {
    const raw = net.createServer((socket) => {
      socket.on('error', () => undefined); // the client may reset the connection
      socket.once('data', () => socket.end('HTTP/1.1 200 O\x01K\r\nContent-Length: 2\r\n\r\nok'));
    });
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
    const rawPort = (raw.address() as AddressInfo).port;
    try {
      const outcome = await pinnedFetch(`http://pinned-host.invalid:${rawPort}/hook`, {
        method: 'GET',
        pinnedAddresses: ['127.0.0.1'],
      }).then(
        async (response) => ({ status: response.status, body: await response.text() }),
        (error: Error) => ({ error: error.message })
      );

      const actual = outcome;
      const expected = { status: 200, body: 'ok' };
      expect(actual).toEqual(expected);
    } finally {
      raw.close();
    }
  });

  it.each([['identity'], ['gzip'], ['deflate, gzip']])(
    'given a %s body that is cancelled before it ends (as the executor does on a redirect hop), should close the socket',
    async (coding) => {
      let serverSocketClosed: Promise<void> = Promise.resolve();
      const partial = encodeBody(coding, Buffer.from('x'.repeat(4096))).subarray(0, 16);
      const raw = net.createServer((socket) => {
        socket.on('error', () => undefined); // the client may reset the connection
        serverSocketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
        socket.once('data', () => {
          socket.write(`HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Encoding: ${coding}\r\nContent-Length: 100000\r\n\r\n`);
          socket.write(partial);
        });
      });
      await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
      const rawPort = (raw.address() as AddressInfo).port;
      try {
        const response = await pinnedFetch(`http://pinned-host.invalid:${rawPort}/hook`, {
          method: 'GET',
          pinnedAddresses: ['127.0.0.1'],
        });
        await response.body?.cancel();

        const actual = await Promise.race([
          serverSocketClosed.then(() => 'closed'),
          new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 1000)),
        ]);
        const expected = 'closed';
        expect(actual).toEqual(expected);
      } finally {
        raw.close();
      }
    }
  );

  it('given a signal that aborts while the body is still arriving, should fail the body read and close the socket', async () => {
    let serverSocketClosed: Promise<void> = Promise.resolve();
    const raw = net.createServer((socket) => {
        socket.on('error', () => undefined); // the client may reset the connection
      serverSocketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.once('data', () => socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nok'));
    });
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
    const rawPort = (raw.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      const response = await pinnedFetch(`http://pinned-host.invalid:${rawPort}/hook`, {
        method: 'GET',
        pinnedAddresses: ['127.0.0.1'],
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);

      const bodyOutcome = await Promise.race([
        response.text().then(() => 'resolved', (error: Error) => error.name),
        new Promise<string>((resolve) => setTimeout(() => resolve('HUNG'), 1000)),
      ]);
      const socketOutcome = await Promise.race([
        serverSocketClosed.then(() => 'closed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 1000)),
      ]);

      const actual = { bodyOutcome, socketOutcome };
      const expected = { bodyOutcome: 'AbortError', socketOutcome: 'closed' };
      expect(actual).toEqual(expected);
    } finally {
      raw.close();
    }
  });

  it('given an unrepresentable status from an upstream that never ends the body, should close the socket rather than leave it open', async () => {
    let serverSocketClosed: Promise<void> = Promise.resolve();
    const raw = net.createServer((socket) => {
        socket.on('error', () => undefined); // the client may reset the connection
      serverSocketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.once('data', () => socket.write('HTTP/1.1 999 Weird\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n'));
    });
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
    const rawPort = (raw.address() as AddressInfo).port;
    try {
      await pinnedFetch(`http://pinned-host.invalid:${rawPort}/hook`, { method: 'GET', pinnedAddresses: ['127.0.0.1'] }).catch(
        () => undefined
      );
      const actual = await Promise.race([
        serverSocketClosed.then(() => 'closed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 1000)),
      ]);
      const expected = 'closed';
      expect(actual).toEqual(expected);
    } finally {
      raw.close();
    }
  });

  it.each([['999'], ['600']])(
    'given an upstream status %s that Response cannot represent, should reject instead of throwing inside the socket listener',
    async (status) => {
      // A raw socket, because node:http servers refuse to write such statuses.
      const raw = net.createServer((socket) => {
        socket.on('error', () => undefined); // the client may reset the connection
        socket.once('data', () => socket.end(`HTTP/1.1 ${status} Weird\r\nContent-Length: 2\r\n\r\nok`));
      });
      await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
      const rawPort = (raw.address() as AddressInfo).port;
      try {
        const outcome = await Promise.race([
          pinnedFetch(`http://pinned-host.invalid:${rawPort}/hook`, { method: 'GET', pinnedAddresses: ['127.0.0.1'] }).then(
            (response) => `resolved ${response.status}`,
            (error: Error) => `rejected: ${error.message}`
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('HUNG'), 1000)),
        ]);

        const actual = outcome;
        const expected = `rejected: Upstream returned an unsupported HTTP status (${status})`;
        expect(actual).toEqual(expected);
      } finally {
        await new Promise<void>((resolve) => raw.close(() => resolve()));
      }
    }
  );

  it.each([['gzip'], ['x-gzip'], ['deflate'], ['br'], ['deflate, gzip'], ['GZIP']])(
    'given a %s-encoded response, should decode it before the body is read (as fetch did)',
    async (coding) => {
      mode = 'encoded';
      encoding = coding;
      const response = await pinnedFetch(`http://pinned-host.invalid:${port}/hook`, {
        method: 'GET',
        pinnedAddresses: ['127.0.0.1'],
      });

      const actual = await response.json();
      const expected = ENCODED_PAYLOAD;
      expect(actual).toEqual(expected);
    }
  );

  it('given no User-Agent, should send a default one (GitHub rejects REST calls without it)', async () => {
    mode = 'json';
    await pinnedFetch(`http://pinned-host.invalid:${port}/hook`, { method: 'GET', pinnedAddresses: ['127.0.0.1'] });

    const actual = lastReceived?.userAgent;
    const expected = DEFAULT_USER_AGENT;
    expect(actual).toEqual(expected);
    expect(DEFAULT_USER_AGENT).toMatch(/\S/);
  });

  it('given a caller User-Agent in any case, should send it unchanged', async () => {
    mode = 'json';
    await pinnedFetch(`http://pinned-host.invalid:${port}/hook`, {
      method: 'GET',
      headers: { 'user-agent': 'custom-tool/2.0' },
      pinnedAddresses: ['127.0.0.1'],
    });

    const actual = lastReceived?.userAgent;
    const expected = 'custom-tool/2.0';
    expect(actual).toEqual(expected);
  });

  it('given a buffered body and no Content-Length, should send its UTF-8 byte length rather than a chunked body', async () => {
    mode = 'json';
    const body = '{"name":"café ☕"}';
    await pinnedFetch(`http://pinned-host.invalid:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      pinnedAddresses: ['127.0.0.1'],
    });

    const actual = {
      contentLength: lastReceived?.contentLength,
      transferEncoding: lastReceived?.transferEncoding,
      body: lastReceived?.body,
    };
    const expected = { contentLength: String(Buffer.byteLength(body, 'utf8')), transferEncoding: undefined, body };
    expect(actual).toEqual(expected);
  });

  it('given a caller-supplied Content-Length in any case, should send that value and never replace it', async () => {
    mode = 'json';
    // The caller's value deliberately differs from the body's byte length (7),
    // so a computed length overriding it is observable on the wire.
    await pinnedFetch(`http://pinned-host.invalid:${port}/hook`, {
      method: 'PUT',
      headers: { 'content-length': '5' },
      body: '{"a":1}',
      pinnedAddresses: ['127.0.0.1'],
    });

    const actual = {
      contentLength: lastReceived?.contentLength,
      transferEncoding: lastReceived?.transferEncoding,
      body: lastReceived?.body,
    };
    const expected = { contentLength: '5', transferEncoding: undefined, body: '{"a":' };
    expect(actual).toEqual(expected);
  });

  it('given an unresolvable hostname and a pinned address, should connect to the address and keep the hostname in Host', async () => {
    mode = 'json';
    const response = await pinnedFetch(`http://pinned-host.invalid:${port}/hook?x=1`, {
      method: 'POST',
      headers: { Authorization: 'Bearer s3cret', 'Content-Type': 'application/json' },
      body: '{"a":1}',
      pinnedAddresses: ['127.0.0.1'],
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
    const response = await pinnedFetch(`http://pinned-host.invalid:${port}/hook`, { method: 'GET', pinnedAddresses: ['127.0.0.1'] });
    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe('');
  });

  it('given a redirect response, should return it as-is and never follow', async () => {
    mode = 'redirect';
    const response = await pinnedFetch(`http://pinned-host.invalid:${port}/hook`, { method: 'GET', pinnedAddresses: ['127.0.0.1'] });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://evil.example/collect');
  });

  it('given an aborted signal while the upstream hangs, should reject with an AbortError', async () => {
    mode = 'hang';
    const controller = new AbortController();
    const pending = pinnedFetch(`http://pinned-host.invalid:${port}/hook`, {
      method: 'GET',
      pinnedAddresses: ['127.0.0.1'],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([
    ['an empty list', []],
    ['a non-IP entry', ['127.0.0.1', 'pinned-host.invalid']],
  ])('given %s of pinned addresses, should refuse rather than resolve the hostname itself', async (_label, pinnedAddresses) => {
    mode = 'json';
    await expect(
      pinnedFetch(`http://pinned-host.invalid:${port}/hook`, { method: 'GET', pinnedAddresses })
    ).rejects.toThrow(/pinned address/i);
  });

  it('given several validated addresses whose first is unreachable, should fall back to the next without resolving', async () => {
    mode = 'json';
    // The server listens on 127.0.0.1 only, so ::1 refuses the connection.
    const response = await pinnedFetch(`http://pinned-host.invalid:${port}/hook`, {
      method: 'GET',
      pinnedAddresses: ['::1', '127.0.0.1'],
    });

    const actual = { status: response.status, host: lastReceived?.host };
    const expected = { status: 200, host: `pinned-host.invalid:${port}` };
    expect(actual).toEqual(expected);
  });

  it('given an earlier request to the same host:port, should not reuse its socket but connect only to this request\'s addresses', async () => {
    mode = 'json';
    const url = `http://pinned-host.invalid:${port}/hook`;
    const first = await pinnedFetch(url, { method: 'GET', pinnedAddresses: ['127.0.0.1'] });
    await first.text();

    // A pooled keep-alive socket to 127.0.0.1 would let this succeed.
    await expect(pinnedFetch(url, { method: 'GET', pinnedAddresses: ['::1'] })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  it('given only the unreachable address (control), should fail to connect', async () => {
    mode = 'json';
    await expect(
      pinnedFetch(`http://pinned-host.invalid:${port}/hook`, { method: 'GET', pinnedAddresses: ['::1'] })
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
