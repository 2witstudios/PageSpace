// A fake apps/web for the imago data tests: the real imago API client over a fetch
// that records every request and answers it from a route table keyed by
// "METHOD /path?query". The CSRF endpoint mints tok-1, tok-2, ….

import { CSRF_ENDPOINT, CSRF_HEADER, createApiClient, type ApiClient } from '@/api/client';

export type Recorded = {
  readonly method: string;
  readonly url: string;
  readonly csrf: string | null;
  readonly body: unknown;
};

export type FakeRoute = (request: Recorded) => Response | Promise<Response>;

export const fakeWeb = (routes: Record<string, FakeRoute>) => {
  const requests: Recorded[] = [];
  let minted = 0;
  const client: ApiClient = createApiClient({
    fetch: async (input, init) => {
      const method = init?.method ?? 'GET';
      if (input === CSRF_ENDPOINT) {
        minted += 1;
        return Response.json({ csrfToken: `tok-${minted}` });
      }
      const headers = new Headers(init?.headers);
      const request: Recorded = {
        method,
        url: input,
        csrf: headers.get(CSRF_HEADER),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      requests.push(request);
      const route = routes[`${method} ${input}`];
      if (!route) throw new Error(`unexpected ${method} ${input}`);
      return route(request);
    },
    navigate: () => {},
    location: () => ({ origin: 'http://localhost:3006', pathname: '/imago/d1/tasks' }),
  });
  /** Requests other than GETs: the writes the client made. */
  const writes = () => requests.filter((request) => request.method !== 'GET');
  const count = (key: string) =>
    requests.filter((request) => `${request.method} ${request.url}` === key).length;
  return { client, requests, writes, count, routes };
};
