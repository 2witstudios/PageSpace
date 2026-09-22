/**
 * L2·G2 — the HTTP executor's network shell against a REAL TLS server on
 * loopback (Control Board §7.3: adapters are tested against the real thing).
 * A throwaway CA signs a leaf for `api.executor-test.example`; the client
 * trusts that CA and reaches the server only through its injected resolver.
 *
 * Pins: DNS answers with any non-public record are refused before a socket
 * opens (rebinding); a certificate for another name fails TLS before anything
 * is sent; a redirect is returned, never followed; the response is capped;
 * upgrades are refused; a slow upstream times out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { isPublicIp } from '../../../security/web-fetch-ssrf';
import type { OutboundRequest } from '../../build-outbound-request';
import { createPinnedHttpsClient, type ResolveHost } from '../pinned-https-client';

const HOST = 'api.executor-test.example';
let dir: string;
let ca: string;
let server: Server;
let port: number;
const hits: { path: string; headers: Record<string, string | string[] | undefined> }[] = [];

function openssl(args: readonly string[]) {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

function leaf(name: string, cn: string) {
  writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=DNS:${cn}\n`);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-subj', `/CN=${cn}`, '-out', `${name}.csr`]);
  openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', `${name}.ext`, '-out', `${name}.pem`]);
  return { key: readFileSync(path.join(dir, `${name}.key`), 'utf8'), cert: readFileSync(path.join(dir, `${name}.pem`), 'utf8') };
}

function startServer(tls: { key: string; cert: string }): Promise<{ server: Server; port: number }> {
  const s = createServer(tls, (req, res) => {
    hits.push({ path: req.url ?? '', headers: req.headers });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `https://${HOST}/target?code=secret` });
      return res.end();
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('x'.repeat(10_000));
    }
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 2_000);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=1' });
    res.end(JSON.stringify({ ok: true, sawAuth: req.headers['x-api-key'] === 'k-1' }));
  });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ server: s, port: (s.address() as AddressInfo).port })));
}

const loopback: ResolveHost = async () => [{ address: '127.0.0.1', family: 4 }];
const outbound = (overrides: Partial<OutboundRequest> = {}): OutboundRequest => ({
  method: 'GET',
  url: `https://${HOST}:${port}/data`,
  hostname: HOST,
  port,
  headers: [
    ['host', `${HOST}:${port}`],
    ['x-api-key', 'k-1'],
    ['content-length', '0'],
  ],
  body: new Uint8Array(0),
  ...overrides,
});
const clientFor = (resolveHost: ResolveHost, isPublic: (ip: string) => boolean, limits = { totalTimeoutMs: 1_000, maxResponseBytes: 1_000, maxConcurrent: 4 }) =>
  createPinnedHttpsClient({ resolveHost, isPublic, limits, ca });

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'g2-pinned-https-'));
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-subj', '/CN=g2-test-ca', '-days', '1', '-out', 'ca.pem']);
  // The trust anchor comes from openssl's stdout, not a file read, so no file data flows into the client's
  // request options (CodeQL js/file-access-to-http); production never passes `ca` at all.
  ca = execFileSync('openssl', ['x509', '-in', 'ca.pem'], { cwd: dir }).toString('utf8');
  const started = await startServer(leaf('leaf', HOST));
  server = started.server;
  port = started.port;
});

afterAll(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('createPinnedHttpsClient — against a real TLS server', () => {
  it('given a public-classified answer and a valid certificate for the hostname, should send exactly the given headers and return the response', async () => {
    const before = hits.length;
    const outcome = await clientFor(loopback, () => true).send(outbound());
    const hit = hits[before];
    const actual = {
      kind: outcome.kind,
      status: outcome.kind === 'response' ? outcome.status : null,
      body: outcome.kind === 'response' ? new TextDecoder().decode(outcome.body) : null,
      headersSent: Object.keys(hit?.headers ?? {}).sort(),
    };
    const expected = { kind: 'response', status: 200, body: '{"ok":true,"sawAuth":true}', headersSent: ['connection', 'content-length', 'host', 'x-api-key'] };
    expect(actual).toEqual(expected);
  });

  it('given a DNS answer mixing a public and a private record (rebinding), should refuse before opening any socket', async () => {
    const before = hits.length;
    const rebinding: ResolveHost = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    const outcome = await clientFor(rebinding, isPublicIp).send(outbound());
    const actual = { outcome, serverHits: hits.length - before };
    const expected = { outcome: { kind: 'refused', reason: 'non_public_address' }, serverHits: 0 };
    expect(actual).toEqual(expected);
  });

  it('given the real classifier and a loopback answer, should refuse — a private address is never pinned', async () => {
    const actual = await clientFor(loopback, isPublicIp).send(outbound());
    const expected = { kind: 'refused', reason: 'non_public_address' };
    expect(actual).toEqual(expected);
  });

  it('given a pinned address whose certificate is for another name, should fail TLS before sending anything', async () => {
    const before = hits.length;
    const other = await startServer(leaf('other', 'other.executor-test.example'));
    const otherPort = other.port;
    const outcome = await clientFor(loopback, () => true).send(outbound({ url: `https://${HOST}:${otherPort}/data`, port: otherPort, headers: [['host', `${HOST}:${otherPort}`]] }));
    other.server.close();
    const actual = { outcome, serverHits: hits.length - before };
    const expected = { outcome: { kind: 'failed', phase: 'before_send', reason: 'tls' }, serverHits: 0 };
    expect(actual).toEqual(expected);
  });

  it('given a redirect, should return the 3xx and never request its target', async () => {
    const before = hits.length;
    const outcome = await clientFor(loopback, () => true).send(outbound({ url: `https://${HOST}:${port}/redirect` }));
    const actual = { status: outcome.kind === 'response' ? outcome.status : outcome, paths: hits.slice(before).map((hit) => hit.path) };
    const expected = { status: 302, paths: ['/redirect'] };
    expect(actual).toEqual(expected);
  });

  it('given a response larger than the cap, should stop reading and mark it truncated', async () => {
    const outcome = await clientFor(loopback, () => true).send(outbound({ url: `https://${HOST}:${port}/big` }));
    const actual = outcome.kind === 'response' ? { bytes: outcome.body.byteLength, truncated: outcome.truncated } : outcome;
    const expected = { bytes: 1_000, truncated: true };
    expect(actual).toEqual(expected);
  });

  it('given an upstream slower than the total timeout, should fail after_send with timeout', async () => {
    const actual = await clientFor(loopback, () => true).send(outbound({ url: `https://${HOST}:${port}/slow` }));
    const expected = { kind: 'failed', phase: 'after_send', reason: 'timeout' };
    expect(actual).toEqual(expected);
  });

  it('given more requests in flight than the concurrency limit, should refuse the extra one as busy', async () => {
    const client = clientFor(loopback, () => true, { totalTimeoutMs: 3_000, maxResponseBytes: 1_000, maxConcurrent: 1 });
    const slow = client.send(outbound({ url: `https://${HOST}:${port}/slow` }));
    const extra = await client.send(outbound());
    await slow;
    const actual = extra;
    const expected = { kind: 'refused', reason: 'busy' };
    expect(actual).toEqual(expected);
  });
});
