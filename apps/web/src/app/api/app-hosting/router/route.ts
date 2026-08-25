/**
 * The published-app serving edge's decision endpoint.
 *
 * The edge proxy (`pagespace-proxy`, Caddy) cannot make this decision: it needs a
 * `published_apps` row and a credit balance. So the proxy forwards every request
 * for the published-apps apex here — rewritten to this path, with the real
 * hostname in a header — and this route answers one of two ways:
 *
 *   • `fly-replay` header → Fly's proxy replays the ORIGINAL request (not this
 *     rewritten one) to the target app, auto-starting its machine if stopped.
 *     The target's response goes straight back to the client and NEVER passes
 *     through us or through Caddy — see `services/app-hosting/router.ts`.
 *   • a page → parked / unavailable / not-found, served from here, with no
 *     machine started.
 *
 * ⚠️ THIS ROUTE IS THE ONLY THING STANDING BETWEEN A HOSTNAME AND A BILLABLE
 * MACHINE START. Everything it refuses to replay is a machine that stays off.
 * That is why it authenticates the caller (below), why it is not cacheable, and
 * why an unknown app status resolves to "unavailable" rather than "replay".
 */

import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { secureCompare } from '@pagespace/lib/auth/secure-compare';
import {
  APP_ROUTER_HOST_HEADER,
  APP_ROUTER_KEY_HEADER,
  resolveAppRouterProxySecret,
} from '@pagespace/lib/services/app-hosting/routing-env';
import { resolveAppRoute } from '@pagespace/lib/services/app-hosting/router';
import {
  buildFlyReplayHeader,
  exceedsReplayableBody,
  MAX_REPLAYABLE_BODY_BYTES,
} from '@pagespace/lib/services/app-hosting/router-core';
import {
  renderAppRouterPage,
  retryAfterFor,
  statusCodeFor,
} from '@pagespace/lib/services/app-hosting/parked-page';

// A routing decision is per-request state (an app's status and its payer's
// balance both change under us), so nothing here may be statically rendered or
// revalidated.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * No response from this route may be cached ANYWHERE — not by a browser, not by
 * an intermediary. A cached parked page outlives the top-up that should have
 * cleared it, and a cached 404 outlives the publish that should have filled it.
 * The metered tier already forgoes `fly-replay-cache` for the same reason; this
 * is the same rule one layer out.
 */
const NO_STORE = 'no-store, no-cache, must-revalidate, private';

function htmlResponse(body: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new NextResponse(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': NO_STORE,
      // The served app controls its own headers (its response bypasses us
      // entirely); these apply only to the pages this route itself renders.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

/**
 * Whether this request really came from the edge proxy.
 *
 * The route is mounted on `pagespace-web`, which also answers at
 * `pagespace.ai/api/...`. Without this check, any internet caller could hand us
 * a published-app hostname and collect a `fly-replay` header — turning our own
 * web app into a general-purpose replay emitter for the whole Fly org, and
 * letting anyone wake (and therefore bill) any published app they can name.
 *
 * An UNSET secret refuses everything. That is the fail-closed direction and it
 * is deliberate: the alternative reading ("no secret configured, so skip the
 * check") disables exactly the protection that stops the endpoint being
 * world-callable, at precisely the moment nobody has configured it.
 */
function isFromEdgeProxy(request: Request): boolean {
  const expected = resolveAppRouterProxySecret();
  if (expected.length === 0) return false;
  const presented = request.headers.get(APP_ROUTER_KEY_HEADER);
  if (!presented) return false;
  return secureCompare(presented, expected);
}

/**
 * The hostname the client actually asked for.
 *
 * The proxy sets it explicitly rather than relying on `Host`, because a rewrite
 * plus an internal `flycast` hop is exactly the sort of path where `Host` gets
 * rewritten by something in the middle. `Host` remains the fallback so a
 * direct-to-web deployment (no separate proxy) still routes.
 *
 * Both are attacker-influenced input by nature; nothing downstream trusts them
 * for anything but a lookup, and the request is authenticated as proxy-origin
 * before we get here.
 */
function requestedHost(request: Request): string {
  return request.headers.get(APP_ROUTER_HOST_HEADER) ?? request.headers.get('host') ?? '';
}

async function handle(request: Request): Promise<Response> {
  if (!isFromEdgeProxy(request)) {
    // Deliberately terse and deliberately 404, not 403: an endpoint that
    // confirms its own existence to an unauthenticated caller is an invitation.
    return new NextResponse(null, { status: 404, headers: { 'Cache-Control': NO_STORE } });
  }

  const host = requestedHost(request);

  // Fly cannot replay a body over 1MB. Answering here with a clear 413 that
  // names the limit is the difference between a documented constraint and a
  // mystery 502 from the platform. Upload paths are supposed to go direct to
  // Tigris via presigned URLs and never reach this edge at all.
  if (exceedsReplayableBody(request.headers.get('content-length'))) {
    return htmlResponse(
      `<!doctype html><meta charset="utf-8"><title>Payload too large</title><p>Request bodies above ${MAX_REPLAYABLE_BODY_BYTES} bytes cannot be routed to a published app. Upload directly to storage instead.`,
      413,
    );
  }

  let decision;
  try {
    decision = await resolveAppRoute(host);
  } catch (error) {
    // A genuine failure (the database is unreachable) is an OUTAGE, and it must
    // read as one. Reporting it as "no such app" would hand every published site
    // a 404 during an incident and teach crawlers the apps are gone.
    loggers.api.error('Published-app router failed to resolve a route', {
      host,
      error: error instanceof Error ? error.message : 'unknown error',
    });
    return htmlResponse(
      renderAppRouterPage({ kind: 'unavailable', reason: 'failed' }, host),
      503,
      { 'Retry-After': '30' },
    );
  }

  if (decision.kind === 'replay') {
    let replay: string;
    try {
      replay = buildFlyReplayHeader({
        flyAppName: decision.flyAppName,
        state: decision.state,
        timeoutMs: decision.timeoutMs,
      });
    } catch (error) {
      loggers.api.error('Published-app router built an invalid fly-replay header', {
        host,
        flyAppName: decision.flyAppName,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      return htmlResponse(
        renderAppRouterPage({ kind: 'unavailable', reason: 'failed' }, host),
        503,
        { 'Retry-After': '30' },
      );
    }
    // 204 with no body: Fly's proxy consumes this response and replays the
    // original request, so the client never sees it. A body here would be pure
    // waste on the hottest path in the system.
    //
    // NO `fly-replay-cache`. The cache skips this hop on subsequent requests,
    // and this hop IS the balance gate — a cached replay would keep a machine
    // awake for a payer we would refuse today. Only the flat-rate dedicated
    // tier may ever set it (see `replayCachePolicyFor`).
    return new NextResponse(null, {
      status: 204,
      headers: { 'fly-replay': replay, 'Cache-Control': NO_STORE },
    });
  }

  const retryAfter = retryAfterFor(decision);
  return htmlResponse(
    renderAppRouterPage(decision, host),
    statusCodeFor(decision),
    retryAfter === null ? {} : { 'Retry-After': String(retryAfter) },
  );
}

// Every method the proxy might forward. A published app may serve any of them,
// and the routing decision does not depend on which — so they all take the same
// path rather than one being quietly unroutable.
export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
