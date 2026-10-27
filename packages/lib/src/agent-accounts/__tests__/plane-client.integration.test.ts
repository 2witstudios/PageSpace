/**
 * L2·G2 review HIGH-2 — the web process's plane client against REAL sockets.
 * An `execute` whose call may have reached the plane (the plane hangs past the
 * client timeout, or answers 5xx) must come back `outcome_unknown` — the
 * request may have run upstream — never `plane_unavailable` ("nothing was
 * sent"). A closed port is provably unreached; a 4xx is the plane refusing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPlaneClient } from '../plane-client';

let server: Server;
let base: string;
const body = { grant: {}, signature: 's', request: { method: 'GET', url: 'https://api.example.com/x', headers: {}, bodyBase64: '' }, run: { human: { userId: 'u', sessionId: 's' }, agentPageId: null, conversationId: 'c', runId: 'r' } };

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/hang/v1/http/execute') return; // never answers
    if (req.url === '/bad/v1/http/execute') {
      res.writeHead(502);
      return res.end();
    }
    res.writeHead(401);
    res.end('{"error":"unauthenticated"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('createPlaneClient — failure classification against real sockets', () => {
  it('given a plane that hangs past the client timeout on execute, should report outcome_unknown', async () => {
    const actual = await createPlaneClient({ baseUrl: `${base}/hang`, secret: 'x'.repeat(40), timeoutMs: 300 }).execute(body);
    const expected = { ok: false, reason: 'outcome_unknown' };
    expect(actual).toEqual(expected);
  });

  it('given a plane answering 502 to execute, should report outcome_unknown; answering 401, refused', async () => {
    const actual = [await createPlaneClient({ baseUrl: `${base}/bad`, secret: 'x'.repeat(40) }).execute(body), await createPlaneClient({ baseUrl: `${base}/auth`, secret: 'x'.repeat(40) }).execute(body)];
    const expected = [
      { ok: false, reason: 'outcome_unknown' },
      { ok: false, reason: 'refused' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given nothing listening, should report plane_unavailable — the call provably never reached a plane', async () => {
    const probe = createServer();
    const closedPort = await new Promise<number>((resolve) => probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port)));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const actual = await createPlaneClient({ baseUrl: `http://127.0.0.1:${closedPort}`, secret: 'x'.repeat(40) }).execute(body);
    const expected = { ok: false, reason: 'plane_unavailable' };
    expect(actual).toEqual(expected);
  });

  it('given a put that times out, should report plane_unavailable so the caller keeps its not-ready row', async () => {
    const actual = await createPlaneClient({ baseUrl: `${base}/hang`, secret: 'x'.repeat(40), timeoutMs: 300 }).revoke({ ref: { tenantId: 't', accountId: 'a', kind: 'api_key' } });
    const expected = { ok: false, reason: 'plane_unavailable' };
    expect(actual).toEqual(expected);
  });
});
