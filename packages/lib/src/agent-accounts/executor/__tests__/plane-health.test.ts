/**
 * Slice 1 (deploy) — the plane's liveness probe. Fly's `[checks.health]` and
 * the image's HEALTHCHECK hit `GET /health` with no credentials, so it must
 * answer without the service signature. It reports liveness only: no
 * dependency state, no version, nothing a caller on the private network could
 * learn from. It must not widen any other route: `GET` on an operation route
 * is still 404, and an unsigned operation call is still 401.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createHmac } from 'node:crypto';
import { createPlaneRequestHandler, type PlaneRequestHandlerDeps } from '../plane-http-adapter';
import { PLANE_ROUTES } from '../plane-wire';

const untouched = (): never => {
  throw new Error('a plane operation was reached');
};

const deps: PlaneRequestHandlerDeps = {
  secret: 'plane-service-secret-0123456789abcdef',
  store: { put: untouched, revoke: untouched, delete: untouched },
  provisioner: { ensureTenant: untouched, identityOf: untouched },
  executor: { execute: untouched } as unknown as PlaneRequestHandlerDeps['executor'],
  hmac: (key, text) => createHmac('sha256', key).update(text).digest('hex'),
  sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
  now: () => 1_800_000_000_000,
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(createPlaneRequestHandler(deps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('plane health probe', () => {
  it('given an unauthenticated GET /health, should answer 200 with liveness only', async () => {
    const response = await fetch(`${base}/health`);
    const actual = { status: response.status, body: await response.json() };
    const expected = { status: 200, body: { ok: true } };
    expect(actual).toEqual(expected);
  });

  it('given GET /health with a query string, should still answer 200', async () => {
    const response = await fetch(`${base}/health?probe=fly`);
    expect(response.status).toBe(200);
  });

  it('given POST /health, should be not found (the probe is GET-only)', async () => {
    const response = await fetch(`${base}/health`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });

  it('given GET on an operation route, should still be not found', async () => {
    const response = await fetch(`${base}${PLANE_ROUTES.execute}`);
    expect(response.status).toBe(404);
  });

  it('given an unsigned POST to an operation route, should still be unauthenticated', async () => {
    const response = await fetch(`${base}${PLANE_ROUTES.revoke}`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });
});
