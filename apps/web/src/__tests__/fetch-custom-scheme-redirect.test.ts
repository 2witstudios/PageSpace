/**
 * @mechanism-evidence
 *
 * Documents the runtime behavior the sw-router fix relies on: when
 * fetch() encounters a 3xx Location pointing at a custom scheme like
 * pagespace://, the returned response is not a normal 2xx that a
 * service worker could hand back as the result of a top-level
 * navigation. This is the reason desktop Google OAuth was landing on a
 * synthetic `{"error":"offline"}` JSON body: sw.js was catching the
 * resulting error and returning that response from its /api/* handler.
 *
 * The navigation-mode invariant in sw-router.js is robust regardless of
 * exactly how fetch fails here — Chrome/Firefox tend to reject with
 * TypeError, other runtimes may return opaqueredirect. Both fail the
 * needs of a service worker trying to synthesize a navigation result.
 * This test records what we actually observe in the test runtime.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('@mechanism-evidence: fetch() redirecting to a custom scheme', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(302, { Location: 'pagespace://auth-exchange?code=test' });
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  test('fetch() cannot produce a follow-through 2xx response', async () => {
    let result: 'threw' | 'ok-2xx' | 'other-status' = 'other-status';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) {
        result = 'ok-2xx';
      }
    } catch {
      result = 'threw';
    }

    // Whether the runtime throws or returns a non-ok response, the
    // invariant holds: a service worker cannot obtain a normal 2xx
    // response to hand back as the navigation result. The sw-router
    // fix therefore routes navigations around fetch() entirely.
    expect(result).not.toBe('ok-2xx');
  });
});
