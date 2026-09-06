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

import { canRunCode } from '@pagespace/lib/services/sandbox/can-run-code';
import { getSandboxSessionSecret } from '@pagespace/lib/services/sandbox/machine-session-manager';
import { resolveDriveMembership } from '@pagespace/lib/services/agent-workspaces/agent-workspace-tenant';
import { isDevPreviewEnabled, resolveDevPreviewApex } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { createDbDevPreviewStore, type DevPreviewStore } from '@pagespace/lib/services/sandbox/preview/dev-preview-store';
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
  derivePreviewCookieKey,
} from '@pagespace/lib/services/sandbox/preview/preview-grant';
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { createRequestScopedSandboxHost } from '@/lib/sandbox/sprites-client';
import { findSessionRecord } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { getDriveEnvStore, resolveDriveEnvPayer } from '@/lib/drive-envs/drive-envs-runtime';

let previewStore: DevPreviewStore | null = null;
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
    attach: async (sandboxId) => {
      const host = await createRequestScopedSandboxHost();
      return host.attach({ sandboxId }).catch(() => null);
    },
    previewStore: getPreviewStore(),
    featureEnabled: isDevPreviewEnabled,
    now: () => new Date(),
  };
}

/** The whole gather for one proxied request. */
export function resolvePreviewTargetForRequest(holder: DevPreviewHolderRef, userId: string): Promise<PreviewTarget> {
  return resolvePreviewTarget({ holder, userId, deps: buildPreviewAccessDeps() });
}

/**
 * Pure: is this request a same-origin fetch/navigation? `Sec-Fetch-Site` is
 * the browser's own attestation; `none` is a user-typed navigation. Absent
 * (a pre-2023 engine, or a non-browser client) fails closed — the handshake
 * must never run inside a foreign page's frame (see the open routes).
 */
export function isSameOriginFetch(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  return site === 'same-origin' || site === 'none';
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
}: {
  /** The holder whose access decision governs — the session the user came through, or the env. */
  authorizeAs: DevPreviewHolderRef;
  /** The holder whose preview origin the grant opens — the env for an env-bound session (the holder rule). */
  mintFor?: DevPreviewHolderRef;
  userId: string;
}): Promise<OpenPreviewResult> {
  const apex = isDevPreviewEnabled() ? resolveDevPreviewApex() : null;
  if (apex === null) return { ok: false, reason: 'not-configured' };
  const authorization: PreviewAuthorization = await authorizePreviewHolder({ holder: authorizeAs, userId, deps: buildPreviewAccessDeps() });
  if (!authorization.allowed) return { ok: false, reason: 'not-authorized', detail: authorization.reason };
  const grant = await getPreviewGrantsStore().mint({ holder: mintFor, userId, now: new Date() });
  return { ok: true, redirectTo: buildPreviewAuthRedirect(buildPreviewHost(mintFor, apex), grant.id) };
}
