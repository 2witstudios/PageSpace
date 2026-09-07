/**
 * The web tier's binding of the dev-preview access gather + the grant mint.
 *
 * Everything that DECIDES lives in `@pagespace/lib` (`preview-access.ts`,
 * `preview-forward-gate.ts`, `dev-preview-core.ts`); this module only wires
 * the real stores, the real membership resolver, the real code-execution
 * gate, and a request-scoped sandbox host into that gather, so the HTTP
 * proxy route and the two `/preview/open` routes ask one question through
 * one binding — and so the realtime tier's WebSocket half, which binds the
 * same gather with its own stores, cannot answer differently.
 */

import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { canRunCode } from '@pagespace/lib/services/sandbox/can-run-code';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { getSandboxSessionSecret } from '@pagespace/lib/services/sandbox/machine-session-manager';
import { resolveDriveMembership } from '@pagespace/lib/services/agent-workspaces/agent-workspace-tenant';
import { isDevPreviewEnabled, resolveDevPreviewApex } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { createDbDevPreviewStore, type DevPreviewStore } from '@pagespace/lib/services/sandbox/preview/dev-preview-store';
import { createDevPreviewLock, DEV_PREVIEW_USER_ACTION_RETRIES, type DevPreviewLock } from '@pagespace/lib/services/sandbox/preview/dev-preview-lock';
import { reconcileStoppedDevPreviews, type DevPreviewReconcileRun } from '@pagespace/lib/services/sandbox/preview/dev-preview-reconcile';
import { createDbDevPreviewGrantsStore, type DevPreviewGrantsStore } from '@pagespace/lib/services/sandbox/preview/dev-preview-grants-store';
import {
  authorizePreviewHolder,
  resolvePreviewTarget,
  type PreviewAccessDeps,
  type PreviewAuthorization,
  type PreviewTarget,
} from '@pagespace/lib/services/sandbox/preview/preview-access';
import {
  buildPreviewAuthRedirect,
  buildPreviewHost,
  buildPreviewOpenPath,
  derivePreviewCookieKey,
} from '@pagespace/lib/services/sandbox/preview/preview-grant';
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import {
  applyDevPreviewUserAction,
  gatherDevPreviewStatus,
  type DevPreviewStatusResult,
  type DevPreviewUserAction,
  type DevPreviewUserActionResult,
} from '@pagespace/lib/services/sandbox/preview/dev-preview-status';
import { createRequestScopedSandboxHost } from '@/lib/sandbox/sprites-client';
import { findSessionRecord } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { getDriveEnvStore, resolveDriveEnvPayer } from '@/lib/drive-envs/drive-envs-runtime';
import { readDevPreviewListeners } from './listeners-source';

let previewStore: DevPreviewStore | null = null;
let previewLock: DevPreviewLock | null = null;

/**
 * The user-action lock, bound lazily — building it resolves the advisory-lock
 * pool, and this module is imported by routes that never take a lock. The
 * retry budget is human-latency shaped: a click contends with at most a
 * handful of control-plane calls, so it almost always acquires, and past the
 * budget the action records the intent and defers the relay work.
 */
function getPreviewLock(): DevPreviewLock {
  previewLock ??= createDevPreviewLock({ retries: DEV_PREVIEW_USER_ACTION_RETRIES, log: loggers.realtime });
  return previewLock;
}
let grantsStore: DevPreviewGrantsStore | null = null;

function getPreviewStore(): DevPreviewStore {
  previewStore ??= createDbDevPreviewStore();
  return previewStore;
}

export function getPreviewGrantsStore(): DevPreviewGrantsStore {
  grantsStore ??= createDbDevPreviewGrantsStore();
  return grantsStore;
}

/** The app's own origin (`WEB_APP_URL`), the ONLY ancestor a preview may be framed by. Null when unconfigured (the policy then fails closed). */
export function resolveAppOrigin(): string | null {
  try {
    const url = process.env.WEB_APP_URL;
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

/** The cookie-signing key derived from the server-held sandbox secret (empty ⇒ nothing verifies). */
export function getPreviewCookieKey(): Buffer {
  return derivePreviewCookieKey(getSandboxSessionSecret());
}

function buildPreviewAccessDeps(): PreviewAccessDeps {
  return {
    findSession: async (workspaceId) => {
      const row = await findSessionRecord(workspaceId);
      if (!row) return null;
      const { id, ownerId, driveId, envId, sandboxId, spriteTornDownAt, endedAt } = row;
      return { id, ownerId, driveId, envId, sandboxId, spriteTornDownAt, endedAt };
    },
    findEnv: async (envId) => {
      const row = await (await getDriveEnvStore()).findById(envId);
      if (!row) return null;
      const { id, driveId, substrate, sandboxId, spriteTornDownAt } = row;
      return { id, driveId, substrate, sandboxId, spriteTornDownAt };
    },
    resolveDriveMembership,
    resolveDrivePayer: async (driveId) => {
      const payer = await resolveDriveEnvPayer(driveId);
      return payer ? { payerId: payer.payerId } : null;
    },
    canRunCode: ({ userId, driveId, ownerId }) => canRunCode({ userId, driveId: driveId ?? undefined, ownerId, requestOrigin: 'user' }),
    isSessionUsable: ({ sessionId, userId }) => sessionService.isSessionUsableById(sessionId, userId),
    attach: async (sandboxId) => {
      const host = await createRequestScopedSandboxHost();
      return host.attach({ sandboxId }).catch(() => null);
    },
    previewStore: getPreviewStore(),
    featureEnabled: isDevPreviewEnabled,
    now: () => new Date(),
  };
}

/** The whole gather for one proxied request. `sessionId` comes from the cookie's claims. */
export function resolvePreviewTargetForRequest(holder: DevPreviewHolderRef, userId: string, sessionId: string): Promise<PreviewTarget> {
  return resolvePreviewTarget({ holder, userId, sessionId, deps: buildPreviewAccessDeps() });
}

/**
 * Pure: may this request run the open handshake? Two shapes are admitted:
 *  - a same-origin request (`Sec-Fetch-Site: same-origin`, or `none` for a
 *    user-typed navigation) — the dashboard framing the preview;
 *  - a TOP-LEVEL document navigation from anywhere (`Sec-Fetch-Dest:
 *    document`) — "open in a new tab", where the partitioned cookie does not
 *    travel and the preview host sends the browser here to re-mint. A
 *    foreign page can only `window.open` this, which lands the user on the
 *    app origin exactly as typing the URL would.
 * A cross-site EMBED (`iframe`/`frame`/`embed` from another site) is refused:
 * the handshake must never run inside a foreign page's frame, where the
 * resulting cookie would be partitioned under that page's site. Absent
 * headers (a pre-2023 engine, a non-browser client) fail closed.
 */
export function isAllowedPreviewOpen(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site === 'same-origin' || site === 'none') return true;
  return request.headers.get('sec-fetch-dest') === 'document';
}

/**
 * An unauthenticated open: a top-level document navigation (the "open in a
 * new tab" re-mint arriving from the preview origin, where the app's
 * SameSite session cookie may not have travelled) is sent to sign in — after
 * which the user reopens from the dashboard; `/api/*` is not an admissible
 * `next=` target, so no `next` is carried. Anything else gets the auth
 * layer's own 401.
 */
export function signInOrDeny(request: Request, denial: NextResponse): NextResponse {
  if (request.headers.get('sec-fetch-dest') !== 'document') return denial;
  return NextResponse.redirect(new URL('/auth/signin', request.url), 302);
}

/**
 * The app-origin route that re-opens a holder's preview — where the preview
 * host sends a cookie-less top-level navigation. An env's route needs the
 * drive id, read from the env row (a lookup that reveals nothing: the app
 * origin enforces authentication before anything else).
 */
export async function resolvePreviewOpenPath(holder: DevPreviewHolderRef): Promise<string | null> {
  if (holder.kind === 'workspace') return buildPreviewOpenPath(holder, null);
  const env = await (await getDriveEnvStore()).findById(holder.id);
  return env ? buildPreviewOpenPath(holder, env.driveId) : null;
}

export type OpenPreviewResult =
  | { ok: true; redirectTo: string }
  | { ok: false; reason: 'not-configured' | 'not-authorized'; detail?: string };

/**
 * The `/preview/open` half of the handshake: authorize the holder for this
 * user (rows only — no control plane, no wake), mint a single-use grant, and
 * name the preview host's auth endpoint to redirect to. The caller has
 * already authenticated the session and checked the route's own drive gate;
 * this re-asks through the shared gather so the grant can never be minted
 * for a holder the proxy would then refuse.
 */
export async function openPreviewForUser({
  authorizeAs,
  mintFor = authorizeAs,
  userId,
  sessionId,
}: {
  /** The holder whose access decision governs — the session the user came through, or the env. */
  authorizeAs: DevPreviewHolderRef;
  /** The holder whose preview origin the grant opens — the env for an env-bound session (the holder rule). */
  mintFor?: DevPreviewHolderRef;
  userId: string;
  /** The session doing the opening; carried into the grant and the cookie so revoking it cuts the preview. */
  sessionId: string;
}): Promise<OpenPreviewResult> {
  const apex = isDevPreviewEnabled() ? resolveDevPreviewApex() : null;
  if (apex === null) return { ok: false, reason: 'not-configured' };
  const authorization: PreviewAuthorization = await authorizePreviewHolder({ holder: authorizeAs, userId, deps: buildPreviewAccessDeps() });
  if (!authorization.allowed) return { ok: false, reason: 'not-authorized', detail: authorization.reason };
  const grant = await getPreviewGrantsStore().mint({ holder: mintFor, userId, sessionId, now: new Date() });
  return { ok: true, redirectTo: buildPreviewAuthRedirect(buildPreviewHost(mintFor, apex), grant.id) };
}

/**
 * The status read behind the detection affordance and the preview pane's
 * chrome — the same rows-only authorization and control-plane attach as the
 * proxy, plus the realtime tier's listener snapshot (never a probe). The
 * caller has authenticated the session and run its own route gate; this
 * re-asks through the shared gather so the read can never answer for a holder
 * the proxy would refuse.
 */
export function readDevPreviewStatusForUser({
  authorizeAs,
  holder = authorizeAs,
  userId,
}: {
  authorizeAs: DevPreviewHolderRef;
  holder?: DevPreviewHolderRef;
  userId: string;
}): Promise<DevPreviewStatusResult> {
  return gatherDevPreviewStatus({ authorizeAs, holder, userId, deps: { ...buildPreviewAccessDeps(), readListeners: readDevPreviewListeners } });
}

/** The rows-only access decision for a holder, as the write routes ask it before applying a user action. */
export function authorizePreviewHolderForUser({ holder, userId }: { holder: DevPreviewHolderRef; userId: string }): Promise<PreviewAuthorization> {
  return authorizePreviewHolder({ holder, userId, deps: buildPreviewAccessDeps() });
}

/**
 * The user's stop/resume, through the core and the effects layer. The caller
 * has ALREADY authorized the write (session access, or drive owner/admin for
 * an env) — this binding only supplies the real store, host and snapshot.
 */
export function applyDevPreviewUserActionForHolder({
  holder,
  action,
  userId,
  wakeSubject,
}: {
  holder: DevPreviewHolderRef;
  action: DevPreviewUserAction;
  userId: string;
  /** `PreviewAuthorization.wakeSubject` — the payer the resume wake gate is asked about. */
  wakeSubject: { driveId: string | null; ownerId: string };
}): Promise<DevPreviewUserActionResult> {
  const deps = buildPreviewAccessDeps();
  return applyDevPreviewUserAction({
    holder,
    action,
    userId,
    wakeSubject,
    deps: { previewStore: deps.previewStore, attach: deps.attach, readListeners: readDevPreviewListeners, canRunCode: deps.canRunCode, lock: getPreviewLock(), now: deps.now },
  });
}

/**
 * The backstop sweep, bound to the real store, host and lock — see
 * `dev-preview-reconcile.ts` for why it exists and why it can only ever stop
 * a relay, never start one. The lock takes NO retries here: busy means a live
 * path already owns the holder and is doing the same work.
 */
export function reconcileStoppedDevPreviewsForCron(): Promise<DevPreviewReconcileRun> {
  const deps = buildPreviewAccessDeps();
  const store = deps.previewStore;
  return reconcileStoppedDevPreviews({
    findStoppedWithRelay: ({ staleAfterMs, limit }) => store.findStoppedWithRelay({ staleAfterMs, limit, now: new Date() }),
    attach: deps.attach,
    previewStore: store,
    lock: createDevPreviewLock({ retries: [], log: loggers.realtime }),
    featureEnabled: isDevPreviewEnabled,
    now: deps.now,
    log: loggers.realtime,
  });
}
