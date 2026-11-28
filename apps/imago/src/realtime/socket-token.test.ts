import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createApiClient } from '@/api/client';
import { ApiError, INVALID_RESPONSE } from '@/api/errors';
import { SOCKET_TOKEN_ENDPOINT, fetchSocketToken } from './socket-token';

type Call = { url: string; method: string; credentials: RequestCredentials | undefined; headers: Headers };

/** An imago API client on a fake fetch that answers the socket-token route with `answer`. */
const clientAnswering = (answer: () => Response) => {
  const calls: Call[] = [];
  const navigations: string[] = [];
  const client = createApiClient({
    fetch: async (input, init) => {
      calls.push({
        url: input,
        method: init?.method ?? 'GET',
        credentials: init?.credentials,
        headers: new Headers(init?.headers),
      });
      if (input !== SOCKET_TOKEN_ENDPOINT) throw new Error(`unexpected fetch ${input}`);
      return answer();
    },
    navigate: (url) => {
      navigations.push(url);
    },
    location: () => ({ origin: 'http://localhost:3006', pathname: '/imago/drive-1/files' }),
  });
  return { client, calls, navigations };
};

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

describe('fetchSocketToken', () => {
  test('a signed-in session', async () => {
    const { client, calls } = clientAnswering(() =>
      Response.json({ token: 'ps_sock_abc', expiresAt: '2026-10-05T00:05:00.000Z' }),
    );

    assert({
      given: "apps/web's socket-token answer",
      should: 'resolve with the ps_sock_ token',
      actual: await fetchSocketToken(client),
      expected: 'ps_sock_abc',
    });

    assert({
      given: 'the request it made',
      should: 'be one same-origin GET of /api/auth/socket-token with no CSRF header',
      actual: calls.map((c) => ({
        url: c.url,
        method: c.method,
        credentials: c.credentials,
        csrf: c.headers.get('x-csrf-token'),
      })),
      expected: [
        { url: '/api/auth/socket-token', method: 'GET', credentials: 'same-origin', csrf: null },
      ],
    });
  });

  test('every call mints a new token', async () => {
    let minted = 0;
    const { client, calls } = clientAnswering(() => {
      minted += 1;
      return Response.json({ token: `ps_sock_${minted}` });
    });

    assert({
      given: 'two calls',
      should: 'fetch twice and resolve with each fresh token (nothing is cached)',
      actual: [await fetchSocketToken(client), await fetchSocketToken(client), calls.length],
      expected: ['ps_sock_1', 'ps_sock_2', 2],
    });
  });

  test('an answer that is not a socket token', async () => {
    for (const body of [{ token: 'ps_sess_long_lived' }, { token: '' }, {}, { token: 7 }]) {
      const { client } = clientAnswering(() => Response.json(body));
      const error = await rejectionOf(fetchSocketToken(client));

      assert({
        given: `the body ${JSON.stringify(body)}`,
        should: 'reject with an INVALID_RESPONSE ApiError, never handing the value to the socket',
        actual: error instanceof ApiError ? error.code : error,
        expected: INVALID_RESPONSE,
      });
    }
  });

  test('a session that is gone', async () => {
    const { client, navigations } = clientAnswering(() =>
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const error = await rejectionOf(fetchSocketToken(client));

    assert({
      given: 'a 401 from the socket-token route',
      should: 'reject with the 401 ApiError',
      actual: error instanceof ApiError ? error.status : error,
      expected: 401,
    });

    assert({
      given: 'a 401 from the socket-token route',
      should: "send the page to sign-in through the API client's 401 handling",
      actual: navigations,
      expected: ['http://localhost:3006/auth/signin?next=%2Fimago%2Fdrive-1%2Ffiles'],
    });
  });
});
