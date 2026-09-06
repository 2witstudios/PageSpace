/**
 * The preview ORIGIN — every request a holder's dedicated preview host
 * receives lands here (the middleware rewrites
 * `https://<kind>-<holderId>.preview.<apex>/<anything>` onto
 * `/api/dev-preview/host/<kind>/<holderId>/<anything>`).
 *
 * Three kinds of request:
 *
 *  - `GET /__pagespace/auth?grant=<id>` — the second half of the handshake.
 *    Consumes the single-use grant (atomically, in the database), refuses it
 *    unless it was minted for THIS host, installs the host-only cookie, and
 *    302s to `/`.
 *  - Anything else WITH a valid preview cookie for THIS host — the proxy.
 *    The cookie authenticates (who, which holder); the drive gate is re-run
 *    for every request through `resolvePreviewTarget`, which also folds the
 *    preview's state and decides whether forwarding would wake the sprite
 *    and whether this user may (`decidePreviewForward`). A `forward` verdict
 *    streams the request to the sprite URL with the org token.
 *  - Anything else WITHOUT a valid cookie — a navigation is sent back to the
 *    app origin's `/preview/open` route to re-mint; a subresource gets 401.
 *
 * NEVER REACHABLE ON THE APP ORIGIN. The `Host` header must parse as a
 * preview host naming the same holder the path names, or the request is
 * 404. A direct `https://<app>/api/dev-preview/host/…` therefore does not
 * exist, so the same-origin path-prefixed proxy the design rejected cannot
 * come back through a side door. The security headers the middleware would
 * add are deliberately absent here (it returns the rewrite bare): this
 * response carries the preview's own `frame-ancestors <app-origin>`, and the
 * app's `X-Frame-Options: DENY` would blank the frame.
 *
 * Attribution: every refusal is audited (`authz.access.denied`) and every
 * forward/refusal is logged with who, which holder, method, bounded path,
 * outcome, status and whether it woke the sprite — never a body.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewEnabled, resolveDevPreviewApex } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { parsePreviewHost, DEV_PREVIEW_HOST_ROUTE_PREFIX } from '@pagespace/lib/services/sandbox/preview/preview-host';
import {
  PREVIEW_AUTH_PATH,
  PREVIEW_GRANT_QUERY_PARAM,
  buildClearPreviewCookieHeader,
  buildPreviewCookieHeader,
  readPreviewCookie,
  signPreviewCookie,
  verifyPreviewCookie,
} from '@pagespace/lib/services/sandbox/preview/preview-grant';
import { buildPreviewAccessLog, extractPreviewPath } from '@pagespace/lib/services/sandbox/preview/preview-proxy-policy';
import { resolveSpritesToken } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { forwardPreviewRequest } from '@/lib/dev-preview/preview-forward';
import { getPreviewCookieKey, getPreviewGrantsStore, resolveAppOrigin, resolvePreviewOpenPath, resolvePreviewTargetForRequest } from '@/lib/dev-preview/preview-runtime';

type RouteContext = { params: Promise<{ kind: string; holderId: string; path?: string[] }> };

const ROUTE = 'dev-preview/host';

function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

function isNavigation(request: Request): boolean {
  const dest = request.headers.get('sec-fetch-dest');
  if (dest !== null) return dest === 'document' || dest === 'iframe' || dest === 'frame';
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/** The holder the path names — must agree with the holder the Host names, or the request is a forgery of one or the other. */
function sameHolder(a: DevPreviewHolderRef, b: DevPreviewHolderRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const startedAt = Date.now();
  const apex = isDevPreviewEnabled() ? resolveDevPreviewApex() : null;
  if (apex === null) return notFound();

  const hostHolder = parsePreviewHost(request.headers.get('host'), apex);
  if (hostHolder === null) return notFound();
  const { kind, holderId } = await context.params;
  if (hostHolder.kind !== kind || hostHolder.id !== holderId) return notFound();
  const holder = hostHolder;

  const mount = `${DEV_PREVIEW_HOST_ROUTE_PREFIX}/${holder.kind}/${holder.id}`;
  const path = extractPreviewPath(request.nextUrl.pathname, mount);
  if (path === null) return notFound();
  const pathAndQuery = `${path}${request.nextUrl.search}`;
  const now = new Date();

  // ---- the handshake's second half ------------------------------------------
  if (path === PREVIEW_AUTH_PATH) {
    if (request.method !== 'GET') return notFound();
    const grantId = request.nextUrl.searchParams.get(PREVIEW_GRANT_QUERY_PARAM) ?? '';
    const consumed = grantId.length === 0 ? null : await getPreviewGrantsStore().consume({ id: grantId, now });
    if (consumed === null || !sameHolder(consumed.holder, holder)) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        resourceType: 'dev_preview',
        resourceId: `${holder.kind}:${holder.id}`,
        details: { route: ROUTE, operation: 'redeem-grant', reason: consumed === null ? 'grant-invalid' : 'grant-holder-mismatch' },
        riskScore: 0.6,
      });
      return NextResponse.json({ error: 'This preview link has expired. Reopen the preview from PageSpace.' }, { status: 403, headers: { 'cache-control': 'no-store' } });
    }
    let cookie: string;
    try {
      cookie = signPreviewCookie({ holder, userId: consumed.userId, expiresAt: consumed.cookieExpiresAt.getTime() }, getPreviewCookieKey());
    } catch {
      loggers.security.error('dev-preview: cookie key not configured (SANDBOX_SESSION_SECRET)');
      return NextResponse.json({ error: 'Preview is not configured' }, { status: 503 });
    }
    loggers.security.info('dev-preview.access', buildPreviewAccessLog({ userId: consumed.userId, holder, method: 'GET', path, outcome: 'forwarded', reason: 'grant-redeemed', status: 302, transport: 'http' }));
    return new NextResponse(null, {
      status: 302,
      headers: { location: '/', 'set-cookie': buildPreviewCookieHeader(cookie, consumed.cookieExpiresAt, now), 'cache-control': 'no-store' },
    });
  }

  // ---- authenticate: the host-only cookie -----------------------------------
  const token = readPreviewCookie(request.headers.get('cookie'));
  const verified = token === null ? null : verifyPreviewCookie(token, getPreviewCookieKey(), now);
  if (verified === null || !verified.ok || !sameHolder(verified.claims.holder, holder)) {
    const reason = verified === null ? 'no-cookie' : verified.ok ? 'cookie-holder-mismatch' : verified.reason;
    if (isNavigation(request)) {
      // Send the navigation back to the app origin to re-mint: the framed
      // case after the cookie expired, and "open in a new tab", where a
      // partitioned cookie does not travel to top-level at all. The app
      // origin is the only place a session lives; it mints a FRESH grant.
      const [appOrigin, openPath] = [resolveAppOrigin(), await resolvePreviewOpenPath(holder)];
      if (appOrigin !== null && openPath !== null) {
        return new NextResponse(null, { status: 302, headers: { location: `${appOrigin}${openPath}`, 'set-cookie': buildClearPreviewCookieHeader(), 'cache-control': 'no-store' } });
      }
    }
    return NextResponse.json({ error: 'Preview session expired. Reopen the preview from PageSpace.', reason }, { status: 401, headers: { 'set-cookie': buildClearPreviewCookieHeader(), 'cache-control': 'no-store' } });
  }
  const userId = verified.claims.userId;

  // ---- authorize + decide, per request ---------------------------------------
  const target = await resolvePreviewTargetForRequest(holder, userId);
  if (target.decision.kind === 'refuse') {
    const { reason, status, message, detail } = target.decision;
    if (reason === 'not-authorized' || reason === 'wake-denied') {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId,
        resourceType: 'dev_preview',
        resourceId: `${holder.kind}:${holder.id}`,
        details: { route: ROUTE, reason, ...(detail ? { detail } : {}) },
        riskScore: reason === 'wake-denied' ? 0.4 : 0.5,
      });
    }
    loggers.security.info('dev-preview.access', buildPreviewAccessLog({ userId, holder, method: request.method, path, outcome: 'refused', reason, status, durationMs: Date.now() - startedAt, transport: 'http' }));
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    if (status === 503) headers['retry-after'] = '2';
    return NextResponse.json({ error: message, reason }, { status, headers });
  }

  // ---- forward ---------------------------------------------------------------
  const outcome = await forwardPreviewRequest({
    request,
    pathAndQuery,
    spriteUrl: target.spriteUrl,
    token: resolveSpritesToken(),
    appOrigin: resolveAppOrigin(),
  });
  const wake = target.decision.wake;
  if (outcome.kind === 'response') {
    loggers.security.info('dev-preview.access', buildPreviewAccessLog({ userId, holder, method: request.method, path, outcome: 'forwarded', status: outcome.upstreamStatus, wake, durationMs: Date.now() - startedAt, transport: 'http' }));
    return outcome.response;
  }
  loggers.security.warn('dev-preview.access', buildPreviewAccessLog({ userId, holder, method: request.method, path, outcome: outcome.kind === 'refused' ? 'limit-exceeded' : 'upstream-error', reason: outcome.reason, status: outcome.status, wake, durationMs: Date.now() - startedAt, transport: 'http' }));
  return NextResponse.json(
    { error: outcome.kind === 'refused' ? 'Request body too large for the preview proxy.' : 'The sandbox did not answer.', reason: outcome.reason },
    { status: outcome.status, headers: { 'cache-control': 'no-store' } },
  );
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
