import { describe, expect, it } from 'vitest';
import { createLoopbackServer, LOOPBACK_HOST } from '@pagespace/cli';

describe('createLoopbackServer', () => {
  it('binds to 127.0.0.1 only, never 0.0.0.0 or an unspecified address', async () => {
    const server = await createLoopbackServer();
    try {
      expect(LOOPBACK_HOST).toBe('127.0.0.1');
      expect(server.port).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it('delivers the query params of the first request to nextCallback()', async () => {
    const server = await createLoopbackServer();
    try {
      const pending = server.nextCallback();
      const responsePromise = fetch(`http://127.0.0.1:${server.port}/callback?code=abc123&state=xyz`);
      const callback = await pending;
      await server.finish('ok');
      const response = await responsePromise;

      expect(callback.query).toEqual({ code: 'abc123', state: 'xyz' });
      expect(response.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('does not let a query key inject onto the object (remote property injection guard)', async () => {
    const server = await createLoopbackServer();
    try {
      const pending = server.nextCallback();
      const responsePromise = fetch(
        `http://127.0.0.1:${server.port}/callback?constructor=pwned&__proto__=pwned&code=ok&state=s`,
      );
      const callback = await pending;
      await server.finish('ok');
      await responsePromise;

      expect(callback.query.code).toBe('ok');
      expect(callback.query.state).toBe('s');
      // Dangerous keys were skipped: `constructor` is still the native constructor,
      // not the attacker's string, and no prototype was polluted.
      expect(callback.query.constructor).not.toBe('pwned');
      expect(Object.prototype.hasOwnProperty.call(callback.query, '__proto__')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('finish() sends the given HTML back to the requester', async () => {
    const server = await createLoopbackServer();
    try {
      const pending = server.nextCallback();
      const responsePromise = fetch(`http://127.0.0.1:${server.port}/callback?code=abc`);
      await pending;
      await server.finish('<p>done</p>');

      const response = await responsePromise;
      const body = await response.text();
      expect(body).toBe('<p>done</p>');
      expect(response.headers.get('content-type')).toContain('text/html');
    } finally {
      await server.close();
    }
  });

  it('allocates a different ephemeral port on each call', async () => {
    const a = await createLoopbackServer();
    const b = await createLoopbackServer();
    try {
      expect(a.port).not.toBe(b.port);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it(
    'a request to a non-/callback path (e.g. a favicon prefetch) does not consume the single-use callback',
    async () => {
      const server = await createLoopbackServer();
      try {
        const pending = server.nextCallback();
        let resolved = false;
        pending.then(() => {
          resolved = true;
        });

        const faviconResponse = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);

        expect(faviconResponse.status).not.toBe(200);
        expect(resolved).toBe(false);

        // The real callback still arrives and is delivered correctly.
        const callbackResponsePromise = fetch(`http://127.0.0.1:${server.port}/callback?code=abc123&state=xyz`);
        const callback = await pending;
        await server.finish('ok');
        const response = await callbackResponsePromise;

        expect(callback.query).toEqual({ code: 'abc123', state: 'xyz' });
        expect(response.status).toBe(200);
      } finally {
        await server.close();
      }
    },
    3000,
  );
});
