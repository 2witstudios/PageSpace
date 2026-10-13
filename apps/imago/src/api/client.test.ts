import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ApiError } from './errors';
import { CSRF_ENDPOINT, createApiClient, type ApiClientIO } from './client';

type Call = { url: string; method: string; headers: Record<string, string>; init?: RequestInit };
type Route = (call: Call) => Response | Promise<Response>;

/**
 * A fake fetch: every request is recorded, and answered by the route for its
 * URL. The CSRF endpoint mints tok-1, tok-2, … unless a test overrides it.
 */
const fakeBrowser = (
  routes: Record<string, Route>,
  { pathname = '/imago/drive-1/files', origin = 'http://localhost:3006' } = {},
) => {
  const calls: Call[] = [];
  const navigations: string[] = [];
  let minted = 0;
  const csrf: Route = () => {
    minted += 1;
    return Response.json({ csrfToken: `tok-${minted}` });
  };
  const io: ApiClientIO = {
    fetch: async (input, init) => {
      const call: Call = {
        url: input,
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        init,
      };
      calls.push(call);
      const route = routes[input] ?? (input === CSRF_ENDPOINT ? csrf : undefined);
      if (!route) throw new Error(`unexpected fetch ${input}`);
      return route(call);
    },
    navigate: (url) => {
      navigations.push(url);
    },
    location: () => ({ origin, pathname }),
  };
  const of = (url: string) => calls.filter((call) => call.url === url);
  return { io, calls, navigations, of, client: createApiClient(io) };
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

const errorShape = (error: unknown) =>
  error instanceof ApiError
    ? { type: 'ApiError', status: error.status, code: error.code, message: error.message }
    : { type: 'other', error: String(error) };

const csrfRejection = (code: string) =>
  Response.json({ error: 'Invalid or expired CSRF token', code }, { status: 403 });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('apiFetch() GET', () => {
  test('request', async () => {
    const browser = fakeBrowser({ '/api/drives': () => Response.json([{ id: 'd1' }]) });
    await browser.client.apiFetch('/api/drives');

    assert({
      given: 'a GET',
      should: 'send the session cookie with same-origin credentials',
      actual: browser.calls[0]?.init?.credentials,
      expected: 'same-origin',
    });

    assert({
      given: 'a GET',
      should: "call web's root-relative route, outside imago's basePath",
      actual: browser.calls.map(({ url, method }) => ({ url, method })),
      expected: [{ url: '/api/drives', method: 'GET' }],
    });

    assert({
      given: 'a GET',
      should: 'neither fetch nor attach a CSRF token',
      actual: { csrfFetches: browser.of(CSRF_ENDPOINT).length, header: browser.calls[0]?.headers['x-csrf-token'] },
      expected: { csrfFetches: 0, header: undefined },
    });

    assert({
      given: 'a GET',
      should: 'ask for JSON',
      actual: browser.calls[0]?.headers.accept,
      expected: 'application/json',
    });
  });

  test('parsed JSON', async () => {
    const browser = fakeBrowser({ '/api/drives': () => Response.json([{ id: 'd1' }]) });

    assert({
      given: 'a 200 JSON response',
      should: 'resolve with the parsed body',
      actual: await browser.client.apiFetch<Array<{ id: string }>>('/api/drives'),
      expected: [{ id: 'd1' }],
    });

    const empty = fakeBrowser({ '/api/x': () => new Response(null, { status: 204 }) });
    assert({
      given: 'a 204 with no body',
      should: 'resolve with null',
      actual: await empty.client.apiFetch('/api/x'),
      expected: null,
    });
  });

  test('typed errors', async () => {
    const notFound = fakeBrowser({
      '/api/pages/p1': () =>
        Response.json({ error: 'Page not found', code: 'NOT_FOUND', details: 'p1' }, { status: 404 }),
    });
    const error = await rejection(notFound.client.apiFetch('/api/pages/p1'));

    assert({
      given: 'an error response with the web error shape',
      should: 'reject with an ApiError carrying its status, code and message',
      actual: errorShape(error),
      expected: { type: 'ApiError', status: 404, code: 'NOT_FOUND', message: 'Page not found' },
    });

    assert({
      given: 'an error response with details',
      should: 'carry the details',
      actual: error instanceof ApiError ? error.details : null,
      expected: 'p1',
    });

    const html = fakeBrowser({
      '/api/x': () => new Response('<html>Bad Gateway</html>', { status: 502 }),
    });
    assert({
      given: 'an error response that is not JSON',
      should: 'reject with an ApiError for the status and no code',
      actual: errorShape(await rejection(html.client.apiFetch('/api/x'))),
      expected: { type: 'ApiError', status: 502, code: null, message: 'Request failed with status 502' },
    });

    const garbled = fakeBrowser({ '/api/x': () => new Response('not json', { status: 200 }) });
    assert({
      given: 'a 200 whose body is not JSON',
      should: 'reject with an INVALID_RESPONSE ApiError rather than resolve',
      actual: errorShape(await rejection(garbled.client.apiFetch('/api/x'))),
      expected: {
        type: 'ApiError',
        status: 200,
        code: 'INVALID_RESPONSE',
        message: 'Response was not valid JSON',
      },
    });
  });

  test('a network failure', async () => {
    const browser = fakeBrowser({
      '/api/x': () => Promise.reject(new TypeError('Failed to fetch')),
    });
    const error = await rejection(browser.client.apiFetch('/api/x'));

    assert({
      given: 'a fetch that never reaches the server',
      should: 'reject with the network error, not an ApiError',
      actual: error instanceof TypeError && !(error instanceof ApiError),
      expected: true,
    });
  });

  test('only root-relative paths', async () => {
    for (const path of ['https://evil.com/api/x', '//evil.com/api/x', '/\\evil.com', 'api/x']) {
      const browser = fakeBrowser({});
      const error = await rejection(browser.client.apiFetch(path, { method: 'POST' }));

      assert({
        given: `the path "${path}"`,
        should: 'refuse it before any request, so credentials and the CSRF token never leave the origin',
        actual: { rejected: error instanceof TypeError, fetches: browser.calls.length },
        expected: { rejected: true, fetches: 0 },
      });
    }
  });

  test('JSON bodies', async () => {
    const browser = fakeBrowser({ '/api/pages': () => Response.json({ id: 'p1' }, { status: 201 }) });
    await browser.client.apiFetch('/api/pages', { method: 'POST', json: { title: 'Notes' } });
    const post = browser.of('/api/pages')[0];

    assert({
      given: 'a json payload',
      should: 'send it serialised with a JSON content type',
      actual: { body: post?.init?.body, contentType: post?.headers['content-type'] },
      expected: { body: '{"title":"Notes"}', contentType: 'application/json' },
    });
  });
});

describe('apiFetch() CSRF', () => {
  test('mutating methods', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      const browser = fakeBrowser({ '/api/x': () => Response.json({ ok: true }) });
      await browser.client.apiFetch('/api/x', { method });
      const csrfCall = browser.of(CSRF_ENDPOINT)[0];

      assert({
        given: `a ${method}`,
        should: 'fetch a token from /api/auth/csrf with the session cookie, then send it',
        actual: {
          order: browser.calls.map(({ url }) => url),
          csrfMethod: csrfCall?.method,
          csrfCredentials: csrfCall?.init?.credentials,
          header: browser.of('/api/x')[0]?.headers['x-csrf-token'],
          credentials: browser.of('/api/x')[0]?.init?.credentials,
        },
        expected: {
          order: [CSRF_ENDPOINT, '/api/x'],
          csrfMethod: 'GET',
          csrfCredentials: 'same-origin',
          header: 'tok-1',
          credentials: 'same-origin',
        },
      });
    }
  });

  test('cached token', async () => {
    const browser = fakeBrowser({ '/api/x': () => Response.json({ ok: true }) });
    await browser.client.apiFetch('/api/x', { method: 'POST' });
    await browser.client.apiFetch('/api/x', { method: 'DELETE' });
    await Promise.all([
      browser.client.apiFetch('/api/x', { method: 'PATCH' }),
      browser.client.apiFetch('/api/x', { method: 'PUT' }),
    ]);

    assert({
      given: 'several mutations, two of them concurrent',
      should: 'fetch the CSRF token once',
      actual: browser.of(CSRF_ENDPOINT).length,
      expected: 1,
    });

    assert({
      given: 'several mutations',
      should: 'send the cached token with each',
      actual: browser.of('/api/x').map(({ headers }) => headers['x-csrf-token']),
      expected: ['tok-1', 'tok-1', 'tok-1', 'tok-1'],
    });
  });

  test('concurrent first mutations', async () => {
    const browser = fakeBrowser({ '/api/x': () => Response.json({ ok: true }) });
    await Promise.all([
      browser.client.apiFetch('/api/x', { method: 'POST' }),
      browser.client.apiFetch('/api/x', { method: 'POST' }),
    ]);

    assert({
      given: 'two mutations before any token is cached',
      should: 'share one in-flight CSRF fetch',
      actual: browser.of(CSRF_ENDPOINT).length,
      expected: 1,
    });
  });

  test('a CSRF 403 refetches once and retries once', async () => {
    let attempts = 0;
    const browser = fakeBrowser({
      '/api/x': () => {
        attempts += 1;
        return attempts === 1 ? csrfRejection('CSRF_TOKEN_INVALID') : Response.json({ ok: true });
      },
    });
    const result = await browser.client.apiFetch('/api/x', { method: 'POST', json: { a: 1 } });

    assert({
      given: 'a mutation rejected with CSRF_TOKEN_INVALID',
      should: 'refetch the token and retry with it',
      actual: browser.calls.map(({ url, headers }) => [url, headers['x-csrf-token'] ?? null]),
      expected: [
        [CSRF_ENDPOINT, null],
        ['/api/x', 'tok-1'],
        [CSRF_ENDPOINT, null],
        ['/api/x', 'tok-2'],
      ],
    });

    assert({
      given: 'a retry that succeeds',
      should: "resolve with the retry's body",
      actual: result,
      expected: { ok: true },
    });

    assert({
      given: 'a retry',
      should: 'resend the same body',
      actual: browser.of('/api/x').map(({ init }) => init?.body),
      expected: ['{"a":1}', '{"a":1}'],
    });

    await browser.client.apiFetch('/api/x', { method: 'POST' });
    assert({
      given: 'a later mutation',
      should: 'reuse the refreshed token without another CSRF fetch',
      actual: {
        csrfFetches: browser.of(CSRF_ENDPOINT).length,
        header: browser.of('/api/x').at(-1)?.headers['x-csrf-token'],
      },
      expected: { csrfFetches: 2, header: 'tok-2' },
    });
  });

  test('a missing token is retried the same way', async () => {
    let attempts = 0;
    const browser = fakeBrowser({
      '/api/x': () => {
        attempts += 1;
        return attempts === 1 ? csrfRejection('CSRF_TOKEN_MISSING') : Response.json({ ok: true });
      },
    });

    assert({
      given: 'a mutation rejected with CSRF_TOKEN_MISSING',
      should: 'refetch the token and retry once',
      actual: {
        result: await browser.client.apiFetch('/api/x', { method: 'POST' }),
        attempts,
      },
      expected: { result: { ok: true }, attempts: 2 },
    });
  });

  test('only once', async () => {
    const browser = fakeBrowser({ '/api/x': () => csrfRejection('CSRF_TOKEN_INVALID') });
    const error = await rejection(browser.client.apiFetch('/api/x', { method: 'POST' }));

    assert({
      given: 'a retry that is rejected for CSRF again',
      should: 'stop after one refetch and one retry',
      actual: { csrfFetches: browser.of(CSRF_ENDPOINT).length, attempts: browser.of('/api/x').length },
      expected: { csrfFetches: 2, attempts: 2 },
    });

    assert({
      given: 'a retry that is rejected for CSRF again',
      should: 'reject with the CSRF ApiError',
      actual: errorShape(error),
      expected: {
        type: 'ApiError',
        status: 403,
        code: 'CSRF_TOKEN_INVALID',
        message: 'Invalid or expired CSRF token',
      },
    });
  });

  test('other 403s are not retried', async () => {
    const cases: Array<[string, () => Response]> = [
      [
        'an ORIGIN_INVALID rejection',
        () => Response.json({ error: 'Origin not allowed', code: 'ORIGIN_INVALID' }, { status: 403 }),
      ],
      ['a permission denial', () => Response.json({ error: 'Forbidden' }, { status: 403 })],
    ];
    for (const [given, respond] of cases) {
      const browser = fakeBrowser({ '/api/x': respond });
      const error = await rejection(browser.client.apiFetch('/api/x', { method: 'POST' }));

      assert({
        given,
        should: 'reject without refetching the token or retrying',
        actual: {
          status: error instanceof ApiError ? error.status : null,
          csrfFetches: browser.of(CSRF_ENDPOINT).length,
          attempts: browser.of('/api/x').length,
        },
        expected: { status: 403, csrfFetches: 1, attempts: 1 },
      });
    }

    const get = fakeBrowser({ '/api/x': () => csrfRejection('CSRF_TOKEN_INVALID') });
    await rejection(get.client.apiFetch('/api/x'));
    assert({
      given: 'a GET answered with a CSRF code',
      should: 'not fetch a token or retry (reads carry no token)',
      actual: { csrfFetches: get.of(CSRF_ENDPOINT).length, attempts: get.of('/api/x').length },
      expected: { csrfFetches: 0, attempts: 1 },
    });
  });

  test('a failed token fetch', async () => {
    let csrfAttempts = 0;
    const browser = fakeBrowser({
      [CSRF_ENDPOINT]: () => {
        csrfAttempts += 1;
        return csrfAttempts === 1
          ? Response.json({ error: 'Failed to generate CSRF token' }, { status: 500 })
          : Response.json({ csrfToken: 'tok-ok' });
      },
      '/api/x': () => Response.json({ ok: true }),
    });
    const error = await rejection(browser.client.apiFetch('/api/x', { method: 'POST' }));

    assert({
      given: 'a CSRF endpoint that fails',
      should: 'reject without sending the mutation',
      actual: { status: error instanceof ApiError ? error.status : null, sent: browser.of('/api/x').length },
      expected: { status: 500, sent: 0 },
    });

    await browser.client.apiFetch('/api/x', { method: 'POST' });
    assert({
      given: 'the next mutation',
      should: 'fetch a token again rather than cache the failure',
      actual: browser.of('/api/x')[0]?.headers['x-csrf-token'],
      expected: 'tok-ok',
    });
  });

  test('a token response without a token', async () => {
    const browser = fakeBrowser({
      [CSRF_ENDPOINT]: () => Response.json({}),
      '/api/x': () => Response.json({ ok: true }),
    });

    assert({
      given: 'a CSRF response with no csrfToken',
      should: 'reject with INVALID_RESPONSE without sending the mutation',
      actual: {
        error: errorShape(await rejection(browser.client.apiFetch('/api/x', { method: 'POST' }))),
        sent: browser.of('/api/x').length,
      },
      expected: {
        error: {
          type: 'ApiError',
          status: 200,
          code: 'INVALID_RESPONSE',
          message: 'CSRF response carried no token',
        },
        sent: 0,
      },
    });
  });
});

describe('apiFetch() 401', () => {
  const unauthorized = () => Response.json({ error: 'Authentication required' }, { status: 401 });

  test('redirect to sign-in', async () => {
    const browser = fakeBrowser({ '/api/drives': unauthorized }, { pathname: '/imago/drive-1/files' });
    const error = await rejection(browser.client.apiFetch('/api/drives'));

    assert({
      given: 'a 401 on a signed-in imago path (production and test: same origin)',
      should: "navigate to classic's sign-in with next= the current imago path",
      actual: browser.navigations,
      expected: ['http://localhost:3006/auth/signin?next=%2Fimago%2Fdrive-1%2Ffiles'],
    });

    assert({
      given: 'a 401',
      should: 'still reject, so callers stop',
      actual: errorShape(error),
      expected: { type: 'ApiError', status: 401, code: null, message: 'Authentication required' },
    });
  });

  test('next dev', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_WEB_APP_URL', 'http://localhost:3000');
    const browser = fakeBrowser({ '/api/drives': unauthorized }, { pathname: '/imago/drive-1/tasks' });
    await rejection(browser.client.apiFetch('/api/drives'));

    assert({
      given: 'a 401 under next dev, where imago does not serve the sign-in page',
      should: "navigate to apps/web's origin with next= the imago path",
      actual: browser.navigations,
      expected: ['http://localhost:3000/auth/signin?next=%2Fimago%2Fdrive-1%2Ftasks'],
    });
  });

  test('next= comes from the browser path only', async () => {
    const fromBody = fakeBrowser({
      '/api/x': () =>
        Response.json({ error: 'Unauthorized', redirect: 'https://evil.com', next: '//evil.com' }, { status: 401 }),
    });
    await rejection(fromBody.client.apiFetch('/api/x'));

    assert({
      given: 'a 401 body naming its own redirect or next',
      should: 'ignore it',
      actual: fromBody.navigations,
      expected: ['http://localhost:3006/auth/signin?next=%2Fimago%2Fdrive-1%2Ffiles'],
    });

    for (const pathname of ['/imago//evil.com', '/auth/signin', '/imago/%2e%2e/admin']) {
      const browser = fakeBrowser({ '/api/x': unauthorized }, { pathname });
      await rejection(browser.client.apiFetch('/api/x'));
      assert({
        given: `the browser path ${pathname}`,
        should: 'fall back to next=/imago',
        actual: new URL(browser.navigations[0] ?? 'http://x').searchParams.get('next'),
        expected: '/imago',
      });
    }
  });

  test('one navigation', async () => {
    const browser = fakeBrowser({ '/api/a': unauthorized, '/api/b': unauthorized });
    await Promise.all([
      rejection(browser.client.apiFetch('/api/a')),
      rejection(browser.client.apiFetch('/api/b')),
    ]);

    assert({
      given: 'several requests answered 401 at once',
      should: 'navigate to sign-in once',
      actual: browser.navigations.length,
      expected: 1,
    });
  });

  test('a 401 from the CSRF endpoint', async () => {
    const browser = fakeBrowser({
      [CSRF_ENDPOINT]: () => Response.json({ error: 'No session found' }, { status: 401 }),
      '/api/x': () => Response.json({ ok: true }),
    });
    const error = await rejection(browser.client.apiFetch('/api/x', { method: 'POST' }));

    assert({
      given: 'a mutation whose CSRF fetch finds no session',
      should: 'redirect to sign-in without sending the mutation',
      actual: {
        navigations: browser.navigations.length,
        sent: browser.of('/api/x').length,
        status: error instanceof ApiError ? error.status : null,
      },
      expected: { navigations: 1, sent: 0, status: 401 },
    });
  });

  test('other statuses do not redirect', async () => {
    for (const status of [400, 403, 404, 500]) {
      const browser = fakeBrowser({ '/api/x': () => Response.json({ error: 'no' }, { status }) });
      await rejection(browser.client.apiFetch('/api/x'));
      assert({
        given: `a ${status}`,
        should: 'not navigate',
        actual: browser.navigations,
        expected: [],
      });
    }
  });
});

describe('apiStream()', () => {
  const sse = (text: string) =>
    new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  test('an unread body', async () => {
    const browser = fakeBrowser({ '/api/ai/chat': () => sse('data: {"type":"start"}\n\n') });
    const response = await browser.client.apiStream('/api/ai/chat', {
      method: 'POST',
      json: { chatId: 'p1' },
      headers: { 'X-Browser-Session-Id': 'tab-1' },
    });
    const sent = browser.of('/api/ai/chat')[0];

    assert({
      given: 'a streaming POST the server accepts',
      should: 'send the CSRF token, credentials, JSON body and extra headers, and hand back the body unread',
      actual: [
        sent?.headers['x-csrf-token'],
        sent?.init?.credentials,
        sent?.init?.body,
        sent?.headers['x-browser-session-id'],
        await response.text(),
      ],
      expected: ['tok-1', 'same-origin', '{"chatId":"p1"}', 'tab-1', 'data: {"type":"start"}\n\n'],
    });
  });

  test('a CSRF 403 retries once', async () => {
    let attempts = 0;
    const browser = fakeBrowser({
      '/api/ai/chat': () => {
        attempts += 1;
        return attempts === 1 ? csrfRejection('CSRF_TOKEN_INVALID') : sse('data: {"type":"finish"}\n\n');
      },
    });
    const response = await browser.client.apiStream('/api/ai/chat', { method: 'POST', json: {} });

    assert({
      given: 'a stale CSRF token',
      should: 'refetch the token, retry once with it and stream the retry',
      actual: [browser.of('/api/ai/chat').map((call) => call.headers['x-csrf-token']), await response.text()],
      expected: [['tok-1', 'tok-2'], 'data: {"type":"finish"}\n\n'],
    });
  });

  test('typed errors', async () => {
    const browser = fakeBrowser({
      '/api/ai/chat': () => Response.json({ error: 'chatId is required' }, { status: 400 }),
    });
    const error = await rejection(browser.client.apiStream('/api/ai/chat', { method: 'POST', json: {} }));

    assert({
      given: 'a refused stream',
      should: 'reject with the ApiError the server described',
      actual: errorShape(error),
      expected: { type: 'ApiError', status: 400, code: null, message: 'chatId is required' },
    });
  });

  test('a 401', async () => {
    const browser = fakeBrowser({ '/api/ai/chat': () => Response.json({ error: 'Unauthorized' }, { status: 401 }) });
    const error = await rejection(browser.client.apiStream('/api/ai/chat', { method: 'POST', json: {} }));

    assert({
      given: 'an expired session',
      should: 'reject with a 401 and leave for sign-in',
      actual: [errorShape(error).status, browser.navigations.length],
      expected: [401, 1],
    });
  });

  test('only root-relative paths', async () => {
    const browser = fakeBrowser({});
    const error = await rejection(browser.client.apiStream('https://evil.test/api/ai/chat', { method: 'POST' }));

    assert({
      given: 'an absolute URL',
      should: 'refuse it before any request carries the token',
      actual: [error instanceof TypeError, browser.calls.length],
      expected: [true, 0],
    });
  });
});
