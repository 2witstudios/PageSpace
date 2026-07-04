import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AuthenticationError, IncompatibleServerError, NetworkError, TimeoutError, ValidationError } from '../errors.js';
import { defineOperation } from '../registry/define.js';
import { PageSpaceClient } from '../client.js';
import type { AuthProvider } from '../auth/provider.js';
import type { RetryPolicy } from '../retry.js';

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

interface MakeClientOptions {
  auth?: AuthProvider;
  fetch: (...args: never[]) => Promise<Response>;
  retryPolicy?: Partial<RetryPolicy>;
  skipVersionCheck?: boolean;
}

function makeClient(options: MakeClientOptions): PageSpaceClient {
  return new PageSpaceClient({
    baseUrl: 'https://pagespace.ai',
    auth: options.auth ?? fakeAuth(),
    jitter: () => 0,
    timeoutMs: 1000,
    retryPolicy: options.retryPolicy,
    skipVersionCheck: options.skipVersionCheck,
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

    await expect(client.invoke(getWidget, { widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
    expect(auth.getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with ValidationError before any network call when input fails the schema', async () => {
    const fetchMock = vi.fn();
    const client = makeClient({ fetch: fetchMock });
    const invalidInvoke = client.invoke.bind(client) as (op: typeof getWidget, input: unknown) => Promise<unknown>;

    await expect(invalidInvoke(getWidget, {})).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
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

    await expect(client.invoke(getWidget, { widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
    expect(auth.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces AuthenticationError with no further loop after a second consecutive 401', async () => {
    const auth = fakeAuth();
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: 'expired' }));
    const client = makeClient({ auth, fetch: fetchMock });

    await expect(client.invoke(getWidget, { widgetId: 'w1' })).rejects.toBeInstanceOf(AuthenticationError);
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

    await expect(client.invoke(getWidget, { widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
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

    await expect(client.invoke(getWidget, { widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after retryPolicy.maxRetries and surfaces the classified error', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: 'unavailable' }));
    const client = makeClient({
      fetch: fetchMock,
      retryPolicy: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 },
    });

    await expect(client.invoke(getWidget, { widgetId: 'w1' })).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial attempt + 2 retries
  });

  it('never retries a non-idempotent (POST) operation on a 5xx', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: 'unavailable' }));
    const client = makeClient({ fetch: fetchMock });

    await expect(client.invoke(createWidget, { label: 'x' })).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries a non-idempotent (POST) operation on a NetworkError', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const client = makeClient({ fetch: fetchMock });

    await expect(client.invoke(createWidget, { label: 'x' })).rejects.toBeInstanceOf(NetworkError);
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

    const promise = client.invoke(getWidget, { widgetId: 'w1' });
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

    const promise = client.invoke(getWidget, { widgetId: 'w1' });
    // Retry-After asked for 1_000_000ms; the policy caps waits at maxDelayMs (500ms).
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toEqual({ id: 'w1', label: 'Widget One' });
  });
});

describe('PageSpaceClient — version handshake (ADR 0001)', () => {
  it('accepts a compatible server header and returns the parsed result', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'w1', label: 'Widget One' }));
    const client = makeClient({ fetch: fetchMock });

    await expect(client.invoke(getWidget, { widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
  });

  it('throws IncompatibleServerError when the version header is missing (fail closed)', async () => {
    const fetchMock = vi.fn(async () => jsonResponseNoVersionHeader(200, { id: 'w1', label: 'Widget One' }));
    const client = makeClient({ fetch: fetchMock });

    await expect(client.invoke(getWidget, { widgetId: 'w1' })).rejects.toBeInstanceOf(IncompatibleServerError);
  });

  it('caches a compatible verdict — a later response missing the header is not re-checked', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(200, { id: 'w1', label: 'Widget One' });
      return jsonResponseNoVersionHeader(200, { id: 'w2', label: 'Widget Two' });
    });
    const client = makeClient({ fetch: fetchMock });

    await client.invoke(getWidget, { widgetId: 'w1' });
    await expect(client.invoke(getWidget, { widgetId: 'w2' })).resolves.toEqual({ id: 'w2', label: 'Widget Two' });
  });

  it('skips the handshake entirely when skipVersionCheck is true', async () => {
    const fetchMock = vi.fn(async () => jsonResponseNoVersionHeader(200, { id: 'w1', label: 'Widget One' }));
    const client = makeClient({ fetch: fetchMock, skipVersionCheck: true });

    await expect(client.invoke(getWidget, { widgetId: 'w1' })).resolves.toEqual({ id: 'w1', label: 'Widget One' });
  });
});

describe('PageSpaceClient — per-operation timeoutMsOverride (Phase 3 task 5 agents.ask)', () => {
  it('times out at the operation override instead of the client default', async () => {
    vi.useFakeTimers();
    const slowOp = defineOperation({
      name: 'widgets.slow',
      method: 'POST',
      path: '/api/widgets/slow',
      inputSchema: z.object({}),
      outputSchema: z.object({ id: z.string() }),
      timeoutMsOverride: 5000,
      description: 'A long-running op.',
    });
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    // Client default timeoutMs is 1000ms (see makeClient) — the override must win.
    const client = makeClient({ fetch: fetchMock as unknown as MakeClientOptions['fetch'] });

    let settled = false;
    const promise = client.invoke(slowOp, {});
    promise.catch(() => {}).finally(() => {
      settled = true;
    });

    // Past the client's own 1000ms default, but still short of the 5000ms override.
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(4000);
    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('PageSpaceClient — registry-derived namespaces', () => {
  it('exposes the built-in seed operations grouped by namespace, mechanically generated (no hand-written wrappers)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/drives')) {
        return jsonResponse(200, [
          {
            id: 'd1',
            name: 'Drive One',
            slug: 'drive-one',
            ownerId: 'u1',
            kind: 'STANDARD',
            isTrashed: false,
            trashedAt: null,
            drivePrompt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            isOwned: true,
            role: 'OWNER',
            lastAccessedAt: null,
            homePageId: null,
          },
        ]);
      }
      return jsonResponse(200, {
        id: 'p1',
        title: 'Page One',
        type: 'DOCUMENT',
        content: null,
        contentMode: 'markdown',
        parentId: null,
        driveId: 'd1',
        position: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: 1,
        stateHash: null,
        isTrashed: false,
        trashedAt: null,
        aiProvider: null,
        aiModel: null,
        systemPrompt: null,
        enabledTools: null,
        isPaginated: null,
        children: [],
        messages: [],
      });
    });
    const client = makeClient({ fetch: fetchMock });

    expect(typeof client.drives.list).toBe('function');
    expect(typeof client.pages.details).toBe('function');

    const drives = await client.drives.list({});
    expect(drives).toHaveLength(1);
    expect(drives[0]?.id).toBe('d1');

    const page = await client.pages.details({ pageId: 'p1' });
    expect(page.id).toBe('p1');
  });

  it('exposes every drives.* operation defined in operations/drives.ts, not just list (regression: only .list was wired)', () => {
    const client = makeClient({ fetch: vi.fn() });

    expect(typeof client.drives.list).toBe('function');
    expect(typeof client.drives.create).toBe('function');
    expect(typeof client.drives.rename).toBe('function');
    expect(typeof client.drives.updateContext).toBe('function');
    expect(typeof client.drives.trash).toBe('function');
    expect(typeof client.drives.restore).toBe('function');
  });

  it('exposes the Phase 3 agents & conversations namespaces', () => {
    const client = makeClient({ fetch: vi.fn() });

    expect(typeof client.agents.list).toBe('function');
    expect(typeof client.agents.listMultiDrive).toBe('function');
    expect(typeof client.agents.updateConfig).toBe('function');
    expect(typeof client.agents.ask).toBe('function');
    expect(typeof client.agents.listModels).toBe('function');
    expect(typeof client.conversations.list).toBe('function');
    expect(typeof client.conversations.read).toBe('function');
  });
});
