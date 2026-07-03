import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AuthenticationError, IncompatibleServerError, NetworkError, ValidationError } from '../errors.js';
import { defineOperation } from '../registry/define.js';
import { PageSpaceClient, type PageSpaceClientOptions } from '../client.js';
import type { AuthProvider } from '../auth/provider.js';

const API_VERSION = '1.0.0';

const getWidget = defineOperation({
  name: 'widgets.get',
  method: 'GET',
  path: '/api/widgets/:widgetId',
  inputSchema: z.object({ widgetId: z.string() }),
  outputSchema: z.object({ id: z.string(), label: z.string() }),
  description: 'Get a widget.',
});

const createWidget = defineOperation({
  name: 'widgets.create',
  method: 'POST',
  path: '/api/widgets',
  inputSchema: z.object({ label: z.string() }),
  outputSchema: z.object({ id: z.string(), label: z.string() }),
  description: 'Create a widget.',
});

const OPERATIONS = { widgets: { get: getWidget, create: createWidget } };

function fakeAuth(overrides: Partial<AuthProvider> = {}): AuthProvider {
  return {
    getAccessToken: vi.fn(async () => 'token-1'),
    invalidate: vi.fn(),
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'X-PageSpace-API-Version': API_VERSION, ...headers },
  });
}

/** A 2xx response that deliberately omits the compatibility header. */
function jsonResponseNoVersionHeader(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

type FetchMock = ReturnType<typeof vi.fn>;

function makeClient(
  options: Partial<PageSpaceClientOptions<typeof OPERATIONS>> & { fetch: FetchMock },
): PageSpaceClient<typeof OPERATIONS> {
  return new PageSpaceClient({
    baseUrl: 'https://pagespace.ai',
    auth: fakeAuth(),
    operations: OPERATIONS,
    jitter: () => 0,
    timeoutMs: 1000,
    ...options,
    fetch: options.fetch as unknown as typeof fetch,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PageSpaceClient — invoke pipeline happy path', () => {
  it('validates input, builds the request, attaches the bearer token, and parses the response', async () => {
    const auth = fakeAuth();
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://pagespace.ai/api/widgets/w1');
      expect(init.method).toBe('GET');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
      return jsonResponse(200, { id: 'w1', label: 'Widget One' });
    });
    const client = makeClient({ auth, fetch: fetchMock });

    await expect(client.widgets.get({ widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
    expect(auth.getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with ValidationError before any network call when input fails the schema', async () => {
    const fetchMock = vi.fn();
    const client = makeClient({ fetch: fetchMock });
    const invalidGet = client.widgets.get as unknown as (input: unknown) => Promise<unknown>;

    await expect(invalidGet({})).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes the same pipeline via the generic invoke() escape hatch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'w1', label: 'Widget One' }));
    const client = makeClient({ fetch: fetchMock });

    await expect(client.invoke(getWidget, { widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
  });
});

describe('PageSpaceClient — 401 handling', () => {
  it('invalidates exactly once and retries with a fresh token after a single 401', async () => {
    const getAccessToken = vi.fn().mockResolvedValueOnce('stale-token').mockResolvedValueOnce('fresh-token');
    const auth = fakeAuth({ getAccessToken });
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      if (call === 1) {
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer stale-token');
        return jsonResponse(401, { error: 'expired' });
      }
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');
      return jsonResponse(200, { id: 'w1', label: 'Widget One' });
    });
    const client = makeClient({ auth, fetch: fetchMock });

    await expect(client.widgets.get({ widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
    expect(auth.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces AuthenticationError with no further loop after a second consecutive 401', async () => {
    const auth = fakeAuth();
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: 'expired' }));
    const client = makeClient({ auth, fetch: fetchMock });

    await expect(client.widgets.get({ widgetId: 'w1' })).rejects.toBeInstanceOf(AuthenticationError);
    expect(auth.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('PageSpaceClient — idempotent-only retry matrix', () => {
  it('retries a 5xx on an idempotent (GET) operation until it succeeds', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call < 3) return jsonResponse(503, { error: 'unavailable' });
      return jsonResponse(200, { id: 'w1', label: 'Widget One' });
    });
    const client = makeClient({ fetch: fetchMock });

    await expect(client.widgets.get({ widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a NetworkError on an idempotent (GET) operation', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('ECONNRESET');
      return jsonResponse(200, { id: 'w1', label: 'Widget One' });
    });
    const client = makeClient({ fetch: fetchMock });

    await expect(client.widgets.get({ widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after retryPolicy.maxRetries and surfaces the classified error', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: 'unavailable' }));
    const client = makeClient({
      fetch: fetchMock,
      retryPolicy: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 },
    });

    await expect(client.widgets.get({ widgetId: 'w1' })).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial attempt + 2 retries
  });

  it('never retries a non-idempotent (POST) operation on a 5xx', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: 'unavailable' }));
    const client = makeClient({ fetch: fetchMock });

    await expect(client.widgets.create({ label: 'x' })).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries a non-idempotent (POST) operation on a NetworkError', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const client = makeClient({ fetch: fetchMock });

    await expect(client.widgets.create({ label: 'x' })).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('PageSpaceClient — RateLimitError retryAfter', () => {
  it('waits the server-specified retryAfterMs before retrying an idempotent operation', async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(429, { error: 'slow down' }, { 'Retry-After': '2' });
      return jsonResponse(200, { id: 'w1', label: 'Widget One' });
    });
    const client = makeClient({ fetch: fetchMock, retryPolicy: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5000 } });

    const promise = client.widgets.get({ widgetId: 'w1' });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toEqual({ id: 'w1', label: 'Widget One' });
  });

  it('bounds retryAfterMs by the policy max delay', async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(429, { error: 'slow down' }, { 'Retry-After': '1000' });
      return jsonResponse(200, { id: 'w1', label: 'Widget One' });
    });
    const client = makeClient({
      fetch: fetchMock,
      retryPolicy: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 500 },
    });

    const promise = client.widgets.get({ widgetId: 'w1' });
    // Retry-After asked for 1_000_000ms; the policy caps waits at maxDelayMs (500ms).
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toEqual({ id: 'w1', label: 'Widget One' });
  });
});

describe('PageSpaceClient — version handshake (ADR 0001)', () => {
  it('accepts a compatible server header and returns the parsed result', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'w1', label: 'Widget One' }));
    const client = makeClient({ fetch: fetchMock });

    await expect(client.widgets.get({ widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
  });

  it('throws IncompatibleServerError when the version header is missing (fail closed)', async () => {
    const fetchMock = vi.fn(async () => jsonResponseNoVersionHeader(200, { id: 'w1', label: 'Widget One' }));
    const client = makeClient({ fetch: fetchMock });

    await expect(client.widgets.get({ widgetId: 'w1' })).rejects.toBeInstanceOf(IncompatibleServerError);
  });

  it('caches a compatible verdict — a later response missing the header is not re-checked', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(200, { id: 'w1', label: 'Widget One' });
      return jsonResponseNoVersionHeader(200, { id: 'w2', label: 'Widget Two' });
    });
    const client = makeClient({ fetch: fetchMock });

    await client.widgets.get({ widgetId: 'w1' });
    await expect(client.widgets.get({ widgetId: 'w2' })).resolves.toEqual({ id: 'w2', label: 'Widget Two' });
  });

  it('skips the handshake entirely when skipVersionCheck is true', async () => {
    const fetchMock = vi.fn(async () => jsonResponseNoVersionHeader(200, { id: 'w1', label: 'Widget One' }));
    const client = makeClient({ fetch: fetchMock, skipVersionCheck: true });

    await expect(client.widgets.get({ widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
  });
});

describe('PageSpaceClient — registry-derived namespaces', () => {
  it('exposes operations grouped by namespace, mechanically generated (no hand-written wrappers)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'w9', label: 'Nine' }));
    const client = makeClient({ fetch: fetchMock });

    expect(typeof client.widgets.get).toBe('function');
    expect(typeof client.widgets.create).toBe('function');
    await expect(client.widgets.get({ widgetId: 'w9' })).resolves.toEqual({ id: 'w9', label: 'Nine' });
  });
});
