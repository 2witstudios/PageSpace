// Imago's one way to call apps/web's API from the browser.
//
// Imago is served same-origin with apps/web (the edge in production, the
// /api rewrite under next dev), so the session cookie rides along with
// same-origin credentials and no token is ever handled here. Mutations carry
// web's CSRF token, fetched once from /api/auth/csrf and cached; a 403 for a
// stale or missing token refetches it once and retries once. A 401 means the
// session is gone: the page leaves for classic's sign-in and comes back to the
// imago path it was on.
//
// Paths are root-relative on purpose: fetch() does not add imago's basePath,
// so `/api/drives` is web's route, not `/imago/api/drives`.

import { basePathRelative, signInLocation, signInOrigin } from '@/lib/auth/sign-in-url';
import {
  ApiError,
  INVALID_RESPONSE,
  apiErrorFrom,
  csrfTokenOf,
  isCsrfRejection,
} from './errors';

/** apps/web's CSRF token route (apps/web/src/app/api/auth/csrf/route.ts). */
export const CSRF_ENDPOINT = '/api/auth/csrf';

export const CSRF_HEADER = 'X-CSRF-Token';

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type ApiClientIO = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** A full-page navigation: sign-in is classic's page, outside imago's router. */
  navigate: (url: string) => void;
  /** Where the browser is now; `pathname` includes imago's basePath. */
  location: () => { origin: string; pathname: string };
};

export type ApiRequestInit = {
  method?: string;
  /** Sent as the JSON request body. */
  json?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type ApiClient = {
  /** Resolves with the parsed JSON body (null for an empty one); rejects with ApiError. */
  apiFetch: <T = unknown>(path: string, init?: ApiRequestInit) => Promise<T>;
};

// Root-relative and nothing else: an absolute or protocol-relative URL would
// carry the CSRF token to another origin.
const assertRootRelative = (path: string): void => {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new TypeError(`imago API paths must be root-relative, got "${path}"`);
  }
};

/** The body as JSON; `undefined` when it is not JSON, null when it is empty. */
const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export function createApiClient(io: ApiClientIO): ApiClient {
  let csrfToken: string | null = null;
  let csrfInFlight: Promise<string> | null = null;
  let leaving = false;

  const unauthorized = (body: unknown): ApiError => {
    csrfToken = null;
    if (!leaving) {
      leaving = true;
      const { origin, pathname } = io.location();
      io.navigate(
        signInLocation({ origin: signInOrigin(origin), pathname: basePathRelative(pathname) }),
      );
    }
    return apiErrorFrom(401, body);
  };

  const fetchCsrfToken = async (): Promise<string> => {
    const response = await io.fetch(CSRF_ENDPOINT, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const body = await readJson(response);
    if (response.status === 401) throw unauthorized(body);
    if (!response.ok) throw apiErrorFrom(response.status, body ?? null);
    const token = csrfTokenOf(body);
    if (!token) {
      throw new ApiError({
        status: response.status,
        code: INVALID_RESPONSE,
        message: 'CSRF response carried no token',
      });
    }
    return token;
  };

  // One fetch at a time, shared by every caller waiting on it. A failure is
  // not cached: the next mutation asks again.
  const csrf = (refresh: boolean): Promise<string> => {
    if (csrfToken && !refresh) return Promise.resolve(csrfToken);
    if (!csrfInFlight) {
      csrfInFlight = fetchCsrfToken()
        .then((token) => {
          csrfToken = token;
          return token;
        })
        .finally(() => {
          csrfInFlight = null;
        });
    }
    return csrfInFlight;
  };

  const apiFetch = async <T,>(path: string, init: ApiRequestInit = {}): Promise<T> => {
    assertRootRelative(path);
    const method = (init.method ?? 'GET').toUpperCase();
    const mutating = MUTATING_METHODS.has(method);
    const body = init.json === undefined ? undefined : JSON.stringify(init.json);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    };

    const send = (token: string | null): Promise<Response> =>
      io.fetch(path, {
        method,
        body,
        signal: init.signal,
        credentials: 'same-origin',
        headers: token ? { ...headers, [CSRF_HEADER]: token } : headers,
      });

    let response = await send(mutating ? await csrf(false) : null);
    let parsed = await readJson(response);

    if (mutating && isCsrfRejection(response.status, parsed)) {
      response = await send(await csrf(true));
      parsed = await readJson(response);
    }

    if (response.status === 401) throw unauthorized(parsed);
    if (!response.ok) throw apiErrorFrom(response.status, parsed ?? null);
    if (parsed === undefined) {
      throw new ApiError({
        status: response.status,
        code: INVALID_RESPONSE,
        message: 'Response was not valid JSON',
      });
    }
    return parsed as T;
  };

  return { apiFetch };
}

let browserClient: ApiClient | null = null;

/** The page's client, created on first use so server rendering never touches window. */
export function getBrowserApiClient(): ApiClient {
  browserClient ??= createApiClient({
    fetch: (input, init) => window.fetch(input, init),
    navigate: (url) => window.location.assign(url),
    location: () => ({ origin: window.location.origin, pathname: window.location.pathname }),
  });
  return browserClient;
}

/** apiFetch on the page's client. */
export const apiFetch = <T = unknown,>(path: string, init?: ApiRequestInit): Promise<T> =>
  getBrowserApiClient().apiFetch<T>(path, init);
