/**
 * Contract tests for the published-app router endpoint.
 *
 * This route is the only thing standing between a hostname and a billable
 * machine start, and it is mounted on the same web app that answers at
 * `pagespace.ai/api/...`. So the boundary property matters as much as the
 * routing one: an unauthenticated caller must not be able to hand us a
 * published-app hostname and collect a `fly-replay` header — that would turn
 * our own web app into a general-purpose replay emitter for the whole Fly org
 * and let anyone wake, and therefore bill, any published app they can name.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

const resolveAppRoute = vi.fn();
vi.mock('@pagespace/lib/services/app-hosting/router', () => ({
  resolveAppRoute: (...args: unknown[]) => resolveAppRoute(...args),
}));

import { GET, POST, HEAD } from '../route';

// >=32 chars: resolveAppRouterProxySecret reads anything shorter as unset.
const PROXY_SECRET = 'proxy-secret-value-padded-to-32ch';
const HOST = 'acme.pagespace.app';

function request(
  headers: Record<string, string> = {},
  init: RequestInit = {},
): Request {
  return new Request('https://pagespace.ai/api/app-hosting/router', {
    ...init,
    headers: {
      'x-pagespace-app-router-key': PROXY_SECRET,
      'x-pagespace-app-host': HOST,
      ...headers,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_ROUTER_PROXY_SECRET = PROXY_SECRET;
  resolveAppRoute.mockResolvedValue({
    kind: 'replay',
    flyAppName: 'pgs-app-abc',
    state: 'ff00',
    timeoutMs: 1500,
  });
});

afterEach(() => {
  delete process.env.APP_ROUTER_PROXY_SECRET;
});

describe('the endpoint answers only the edge proxy', () => {
  it('given no proxy key, should 404 without resolving anything', async () => {
    const res = await GET(
      new Request('https://pagespace.ai/api/app-hosting/router', {
        headers: { 'x-pagespace-app-host': HOST },
      }),
    );
    expect(res.status).toBe(404);
    expect(resolveAppRoute).not.toHaveBeenCalled();
  });

  it('given a WRONG proxy key, should 404 and never emit a replay', async () => {
    const res = await GET(request({ 'x-pagespace-app-router-key': 'not-the-secret' }));
    expect(res.status).toBe(404);
    expect(res.headers.get('fly-replay')).toBeNull();
    expect(resolveAppRoute).not.toHaveBeenCalled();
  });

  it('given the secret is UNSET, should refuse everything rather than skip the check', async () => {
    // The fail-closed direction: an unconfigured secret must not silently
    // disable the protection that stops this endpoint being world-callable.
    delete process.env.APP_ROUTER_PROXY_SECRET;
    const res = await GET(request());
    expect(res.status).toBe(404);
    expect(resolveAppRoute).not.toHaveBeenCalled();
  });

  it('given the correct key, should route', async () => {
    const res = await GET(request());
    expect(res.status).toBe(204);
    expect(resolveAppRoute).toHaveBeenCalledWith(HOST);
  });
});

describe('the hostname the decision is made about', () => {
  it('given the explicit host header, should prefer it over Host', async () => {
    await GET(request({ 'x-pagespace-app-host': 'real.pagespace.app', host: 'internal.flycast' }));
    expect(resolveAppRoute).toHaveBeenCalledWith('real.pagespace.app');
  });

  it('given no explicit header, should fall back to Host for a direct-to-web deployment', async () => {
    const res = new Request('https://pagespace.ai/api/app-hosting/router', {
      headers: { 'x-pagespace-app-router-key': PROXY_SECRET, host: 'fallback.pagespace.app' },
    });
    await GET(res);
    expect(resolveAppRoute).toHaveBeenCalledWith('fallback.pagespace.app');
  });
});

describe('a replay decision', () => {
  it('given a replay, should emit the fly-replay header with the timeout and no body', async () => {
    const res = await GET(request());
    expect(res.status).toBe(204);
    expect(res.headers.get('fly-replay')).toBe('app=pgs-app-abc;state=ff00;timeout=1500');
    expect(await res.text()).toBe('');
  });

  it('given a replay, should NOT set fly-replay-cache — the cache would skip the balance gate', async () => {
    const res = await GET(request());
    expect(res.headers.get('fly-replay-cache')).toBeNull();
  });

  it('given a replay, should forbid caching the decision', async () => {
    const res = await GET(request());
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('given a decision carrying header grammar, should refuse rather than emit a redirectable header', async () => {
    resolveAppRoute.mockResolvedValue({
      kind: 'replay',
      flyAppName: 'pgs-app;app=victim',
      state: 'ff00',
      timeoutMs: 1500,
    });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get('fly-replay')).toBeNull();
  });
});

describe('a refusal is served here, and starts no machine', () => {
  it('given a parked app, should answer 402 with a page and no replay', async () => {
    resolveAppRoute.mockResolvedValue({ kind: 'parked', reason: 'out_of_credits' });
    const res = await GET(request());
    expect(res.status).toBe(402);
    expect(res.headers.get('fly-replay')).toBeNull();
    expect(await res.text()).toMatch(/credits/i);
  });

  it('given a deploying app, should answer 503 with a Retry-After', async () => {
    resolveAppRoute.mockResolvedValue({ kind: 'unavailable', reason: 'deploying' });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('15');
  });

  it('given no such app, should answer 404 with no Retry-After', async () => {
    resolveAppRoute.mockResolvedValue({ kind: 'not_found', reason: 'no_such_app' });
    const res = await GET(request());
    expect(res.status).toBe(404);
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('given any served page, should carry its own hardening headers', async () => {
    resolveAppRoute.mockResolvedValue({ kind: 'parked', reason: 'out_of_credits' });
    const res = await GET(request());
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('given the parked page, should allow the inline styles it is actually built from', async () => {
    // The page is a single self-contained document styled with `style=`
    // attributes. Middleware skips its own CSP for this path precisely so this
    // policy is the one that applies; a policy without style-src would render
    // the customer-facing enforcement page as unstyled text.
    resolveAppRoute.mockResolvedValue({ kind: 'parked', reason: 'out_of_credits' });
    const res = await GET(request());
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(await res.text()).toContain('style=');
    // Everything else stays shut.
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
  });
});

describe('the 1MB replay ceiling is named, not discovered', () => {
  it('given a body past the limit, should answer 413 rather than let Fly 502', async () => {
    const res = await POST(request({ 'content-length': String(1_048_577) }, { method: 'POST' }));
    expect(res.status).toBe(413);
    expect(resolveAppRoute).not.toHaveBeenCalled();
  });

  it('given a body at the limit, should route normally', async () => {
    const res = await POST(request({ 'content-length': String(1_048_576) }, { method: 'POST' }));
    expect(res.status).toBe(204);
  });

  /**
   * A chunked body: no `Content-Length`, delivered as a stream. This is the
   * shape a streaming upload takes by default, and before the streamed check it
   * walked straight past the header gate into a `fly-replay` Fly could not
   * perform — surfacing to the client as an opaque 502 from the platform rather
   * than as the 413 this edge exists to give them.
   */
  const chunkedRequest = (totalBytes: number): Request => {
    const chunk = 64 * 1024;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunk, totalBytes - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size));
      },
    });
    return request({}, { method: 'POST', body, duplex: 'half' } as RequestInit);
  };

  it('given a chunked body past the limit, should answer 413 rather than emit an unreplayable fly-replay', async () => {
    const res = await POST(chunkedRequest(1_048_577));
    expect(res.status).toBe(413);
    expect(res.headers.get('fly-replay')).toBeNull();
    expect(resolveAppRoute).not.toHaveBeenCalled();
  });

  it('given a chunked body within the limit, should route normally', async () => {
    const res = await POST(chunkedRequest(128 * 1024));
    expect(res.status).toBe(204);
    expect(res.headers.get('fly-replay')).toBe('app=pgs-app-abc;state=ff00;timeout=1500');
  });

  it('given a bodyless GET, should route without paying for a stream read', async () => {
    const res = await GET(request());
    expect(res.status).toBe(204);
  });

  // Measuring the body is the only step on this path that can throw, and a body
  // that fails mid-read is ordinary at a serving edge: a client hangs up, an
  // upload truncates. Before this was handled it propagated out of the handler
  // as an unhandled 500 with a stack trace, on the hottest route in the system.
  it('given a body that errors mid-read, should answer 400 rather than throw', async () => {
    const erroring = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      pull(controller) {
        controller.error(new TypeError('terminated'));
      },
    });

    const res = await POST(
      request({}, { method: 'POST', body: erroring, duplex: 'half' } as RequestInit),
    );

    expect(res.status).toBe(400);
    // Refused before any routing decision, and with no replay emitted — we could
    // not establish the size, so Fly must not be handed the request.
    expect(res.headers.get('fly-replay')).toBeNull();
    expect(resolveAppRoute).not.toHaveBeenCalled();
  });
});

describe('an outage reads as an outage', () => {
  it('given the resolver throws, should answer 503 rather than teach crawlers the app is gone', async () => {
    resolveAppRoute.mockRejectedValue(new Error('connection terminated'));
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.status).not.toBe(404);
    expect(res.headers.get('Retry-After')).toBe('30');
  });
});

describe('every method the proxy might forward is routable', () => {
  it.each([
    ['GET', GET],
    ['HEAD', HEAD],
    ['POST', POST],
  ])('given a %s request, should reach the same decision', async (method, handler) => {
    const res = await handler(request({}, { method: method === 'HEAD' ? 'HEAD' : method }));
    expect(res.status).toBe(204);
  });
});
