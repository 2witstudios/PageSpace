// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import useSWR, { useSWRConfig, type Cache } from 'swr';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createApiClient, type ApiClient } from './client';
import { ApiError } from './errors';
import { ImagoSWRProvider, shouldRetryOnError } from './swr-provider';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
});

const render = (tree: ReactNode): void => {
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => {
    root.render(tree);
  });
};

/** A client on a fake fetch that answers every GET with its own URL, counting requests per URL. */
const countingClient = () => {
  const requests: string[] = [];
  const client: ApiClient = createApiClient({
    fetch: async (input) => {
      requests.push(input);
      return Response.json({ url: input });
    },
    navigate: () => {},
    location: () => ({ origin: 'http://localhost:3006', pathname: '/imago' }),
  });
  return { client, requests, count: (url: string) => requests.filter((r) => r === url).length };
};

type Seen = { data: unknown; cache: Cache | null };

/** Reads `key` through SWR and records what it saw and which cache it used. */
const reader = (key: string) => {
  const seen: Seen = { data: undefined, cache: null };
  function Reader() {
    const { data } = useSWR(key);
    const { cache } = useSWRConfig();
    seen.data = data;
    seen.cache = cache;
    return null;
  }
  return { Reader, seen };
};

const settle = (check: () => void) => vi.waitFor(check, { timeout: 1000, interval: 5 });

describe('ImagoSWRProvider', () => {
  test('fetches through the imago client', async () => {
    const api = countingClient();
    const a = reader('/api/drives');
    render(
      <ImagoSWRProvider client={api.client}>
        <a.Reader />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (a.seen.data === undefined) throw new Error('not loaded');
    });

    assert({
      given: 'a useSWR key under the provider',
      should: "load it with the imago client's apiFetch",
      actual: a.seen.data,
      expected: { url: '/api/drives' },
    });
  });

  test('one shared cache, identical keys deduped', async () => {
    const api = countingClient();
    const a = reader('/api/drives');
    const b = reader('/api/drives');
    const c = reader('/api/user/builtin-agents');
    render(
      <ImagoSWRProvider client={api.client}>
        <a.Reader />
        <div>
          <b.Reader />
        </div>
        <c.Reader />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (a.seen.data === undefined || b.seen.data === undefined || c.seen.data === undefined) {
        throw new Error('not loaded');
      }
    });

    assert({
      given: 'two components reading the same key',
      should: 'send one request for it',
      actual: api.count('/api/drives'),
      expected: 1,
    });

    assert({
      given: 'a component reading a different key',
      should: 'send its own request',
      actual: api.count('/api/user/builtin-agents'),
      expected: 1,
    });

    assert({
      given: 'components anywhere under the provider',
      should: 'share one cache',
      actual: a.seen.cache !== null && a.seen.cache === b.seen.cache && b.seen.cache === c.seen.cache,
      expected: true,
    });

    assert({
      given: 'a loaded key',
      should: 'hold its data in that shared cache',
      actual: a.seen.cache?.get('/api/drives')?.data,
      expected: { url: '/api/drives' },
    });

    const late = reader('/api/drives');
    const lateRoot = createRoot(document.createElement('div'));
    roots.push(lateRoot);
    act(() => {
      lateRoot.render(
        <ImagoSWRProvider client={api.client}>
          <late.Reader />
        </ImagoSWRProvider>,
      );
    });
    await settle(() => {
      if (late.seen.data === undefined) throw new Error('not loaded');
    });

    assert({
      given: 'a second, separate provider (the control)',
      should: 'own a different cache and fetch the key again',
      actual: { sameCache: late.seen.cache === a.seen.cache, requests: api.count('/api/drives') },
      expected: { sameCache: false, requests: 2 },
    });
  });

  test('a provider re-render keeps its cache', async () => {
    const api = countingClient();
    const a = reader('/api/drives');
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    const tree = (label: string) => (
      <ImagoSWRProvider client={api.client}>
        <span>{label}</span>
        <a.Reader />
      </ImagoSWRProvider>
    );
    act(() => root.render(tree('first')));
    await settle(() => {
      if (a.seen.data === undefined) throw new Error('not loaded');
    });
    const before = a.seen.cache;
    act(() => root.render(tree('second')));

    assert({
      given: 'the provider re-rendering with new children',
      should: 'keep the same cache',
      actual: a.seen.cache === before,
      expected: true,
    });
  });
});

describe('shouldRetryOnError()', () => {
  test('retries', () => {
    const cases: Array<[string, Error, boolean]> = [
      ['a network failure', new TypeError('Failed to fetch'), true],
      ['a server error', new ApiError({ status: 503, code: null, message: 'down' }), true],
      ['a 401 (the page is leaving for sign-in)', new ApiError({ status: 401, code: null, message: 'x' }), false],
      ['a 403', new ApiError({ status: 403, code: null, message: 'x' }), false],
      ['a 404', new ApiError({ status: 404, code: null, message: 'x' }), false],
    ];
    for (const [given, error, expected] of cases) {
      assert({
        given,
        should: expected ? 'let SWR retry' : 'not retry: asking again gets the same answer',
        actual: shouldRetryOnError(error),
        expected,
      });
    }
  });
});
