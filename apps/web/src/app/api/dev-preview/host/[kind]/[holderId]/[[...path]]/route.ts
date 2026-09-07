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
 *  - Anything else WITHOUT a valid cookie — a navigation gets a small
 *    re-auth page on THIS origin (401) that hands the re-mint to the
 *    dashboard by `postMessage` when framed, or navigates a top-level tab to
 *    the app origin's `/preview/open`; a subresource gets a bare 401.
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

import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewEnabled, resolveDevPreviewApex } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { DEV_PREVIEW_MESSAGE_TYPE, DEV_PREVIEW_REAUTH_EVENT } from '@pagespace/lib/services/sandbox/preview/dev-preview-contract';
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

/**
 * The re-auth page's ONE script, hashed for its CSP. It reads its inputs from
 * `data-*` attributes (never interpolated into the script, so the hash holds
 * and nothing from the request reaches script context). The dashboard's
 * contract (consumed by the UI task): a `message` from the preview frame
 * `{ type: 'pagespace:dev-preview', event: 'reauth-required', holder }` means
 * "re-point my iframe at the app-origin open route".
 */
const REAUTH_SCRIPT = [
  "var d=document.currentScript.dataset;",
  "var holder={kind:d.kind,id:d.id};",
  `if(window.parent!==window){window.parent.postMessage({type:'${DEV_PREVIEW_MESSAGE_TYPE}',event:'${DEV_PREVIEW_REAUTH_EVENT}',holder:holder},d.appOrigin);}`,
  "else{window.location.replace(d.openUrl);}",
].join('');
const REAUTH_SCRIPT_HASH = `sha256-${createHash('sha256').update(REAUTH_SCRIPT).digest('base64')}`;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildReauthPage({ appOrigin, openPath, holder }: { appOrigin: string; openPath: string; holder: DevPreviewHolderRef }): string {
  const openUrl = `${appOrigin}${openPath}`;
  return `<!doctype html><meta charset="utf-8"><title>Preview session expired</title>`
    + `<p>Your preview session expired. <a href="${escapeAttribute(openUrl)}" target="_top">Reopen the preview</a> from PageSpace.</p>`
    + `<script data-kind="${escapeAttribute(holder.kind)}" data-id="${escapeAttribute(holder.id)}" data-app-origin="${escapeAttribute(appOrigin)}" data-open-url="${escapeAttribute(openUrl)}">${REAUTH_SCRIPT}</script>`;
}

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
    // The key is checked BEFORE the grant is consumed: a grant is single-use,
    // and burning it only to answer 503 would strand the user.
    const cookieKey = getPreviewCookieKey();
    if (cookieKey.length === 0) {
      loggers.security.error('dev-preview: cookie key not configured (SANDBOX_SESSION_SECRET)');
      return NextResponse.json({ error: 'Preview is not configured' }, { status: 503 });
    }
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
    // The grant carries the session that opened it; the cookie carries it on,
    // so revoking that session cuts this preview on its very next request.
    const cookie = signPreviewCookie({ holder, userId: consumed.userId, sessionId: consumed.sessionId, expiresAt: consumed.cookieExpiresAt.getTime() }, cookieKey);
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
    loggers.security.info('dev-preview.access', buildPreviewAccessLog({ userId: 'anonymous', holder, method: request.method, path, outcome: 'refused', reason, status: 401, transport: 'http' }));
    if (isNavigation(request)) {
      // A navigation with no usable cookie cannot be sent straight to the
      // app origin: this host is cross-site to the app BY DESIGN, so a
      // redirect from here arrives there without the app's SameSite session
      // cookie and outside the open route's same-origin rule. Instead serve
      // a tiny page on THIS origin that hands the re-mint to whoever can do
      // it: framed → `postMessage` to the dashboard (which re-points the
      // iframe at `/preview/open` same-origin, cookies and all); top-level
      // ("open in a new tab", where a partitioned cookie never travels) →
      // navigate to the app origin's open route, which admits a top-level
      // document navigation and sends an unauthenticated one to sign in.
      const [appOrigin, openPath] = [resolveAppOrigin(), await resolvePreviewOpenPath(holder)];
      if (appOrigin !== null && openPath !== null) {
        return new NextResponse(buildReauthPage({ appOrigin, openPath, holder }), {
          status: 401,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': `default-src 'none'; script-src '${REAUTH_SCRIPT_HASH}'; frame-ancestors ${appOrigin}`,
            'set-cookie': buildClearPreviewCookieHeader(),
            'cache-control': 'no-store',
          },
        });
      }
    }
    return NextResponse.json({ error: 'Preview session expired. Reopen the preview from PageSpace.', reason }, { status: 401, headers: { 'set-cookie': buildClearPreviewCookieHeader(), 'cache-control': 'no-store' } });
  }
  const { userId, sessionId } = verified.claims;

  // ---- authorize + decide, per request ---------------------------------------
  const target = await resolvePreviewTargetForRequest(holder, userId, sessionId);
  if (!('spriteUrl' in target)) {
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

    // A DEAD SESSION IS A RE-AUTH, NOT A DEAD END. The cookie is well-formed
    // and correctly signed; the session it names is simply gone — and the
    // commonest way for that to happen is not a sign-out but a ROTATION: a
    // device refresh mints a replacement session row and grace-expires the
    // old one, which fires on a desktop unlock, an app foregrounding, any
    // 401. The user is still signed in, on a page that still works, and
    // without this the frame would sit on `404 {"error":"Not found"}` for the
    // rest of the cookie's life while the dashboard around it reports the
    // preview healthy. So the stale cookie is cleared and the same re-auth
    // path a missing cookie takes is served: framed, it asks the dashboard to
    // re-point at `/preview/open`, which mints a grant from the session the
    // user actually has now. Refused subresources clear the cookie too, so
    // the frame's next navigation re-auths rather than accumulating 404s.
    const staleSession = detail === 'session_revoked';
    if (staleSession && isNavigation(request)) {
      const [appOrigin, openPath] = [resolveAppOrigin(), await resolvePreviewOpenPath(holder)];
      if (appOrigin !== null && openPath !== null) {
        return new NextResponse(buildReauthPage({ appOrigin, openPath, holder }), {
          status: 401,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': `default-src 'none'; script-src '${REAUTH_SCRIPT_HASH}'; frame-ancestors ${appOrigin}`,
            'set-cookie': buildClearPreviewCookieHeader(),
            'cache-control': 'no-store',
          },
        });
      }
    }

    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    if (status === 503) headers['retry-after'] = '2';
    if (staleSession) headers['set-cookie'] = buildClearPreviewCookieHeader();
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
