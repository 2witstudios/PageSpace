/**
 * Preview ACCESS — the one gather both halves of the proxy run.
 *
 * The web tier (HTTP) and the realtime tier (WebSocket upgrades) both have to
 * answer, for a (holder, user) pair on every request: may this user reach
 * this holder's preview, which sprite is it, what state is the preview in,
 * would forwarding wake the sprite, and may this user wake it? This module
 * gathers those facts through injected IO and hands them to the pure
 * deciders — `decideAgentSessionAccess` for a session holder (the SAME
 * decider the session API routes and the shell bridge enforce),
 * `describeServiceState` for the preview, `decidePreviewForward` for the
 * verdict. It contains no rule of its own; every `if` below turns a missing
 * row into a refusal or sequences a read after the read it depends on.
 *
 * ORDER, again, is the security property (see `preview-forward-gate.ts`):
 * authorization is decided from DATABASE rows only, before any control-plane
 * read; a refused user never causes a `getSprite`, let alone a wake. The
 * wake gate (`canRunCode` on the holder's PAYER, the same posture a session
 * ensure applies) is consulted only when the forward decision asks for it.
 *
 * NEVER PROBE TO RENDER: the preview's state is folded from the row and a
 * control-plane service read (`services.get`) with `listeners: null` —
 * exactly what the core's docblock prescribes for a status render that holds
 * no `ports/watch` snapshot. The one thing this module asks the sprite for is
 * its URL and power state, both control-plane reads (`urlInfo`, `powerState`).
 */

import {
  decideAgentSessionAccess,
  type DriveMembership,
} from '../../../agent-workspaces/decide-workspace-access';
import type { CanRunCodeResult } from '../can-run-code';
import type { SandboxHandle } from '../sandbox-host';
import { resolveLiveSandboxId } from '../../agent-workspaces/workspace-status';
import { describeServiceState, type DevPreviewHolderRef } from './dev-preview-core';
import type { DevPreviewStore } from './dev-preview-store';
import { decidePreviewForward, type PreviewAuthz, type PreviewForwardDecision } from './preview-forward-gate';
import { PREVIEW_RELAY_SERVICE_NAME } from './preview-relay';

/** The session row slice the access gather reads. */
export interface PreviewSessionRow {
  id: string;
  ownerId: string;
  driveId: string | null;
  envId: string | null;
  sandboxId: string | null;
  spriteTornDownAt: Date | null;
  endedAt: Date | null;
}

/** The env row slice the access gather reads. */
export interface PreviewEnvRow {
  id: string;
  driveId: string;
  substrate: 'sprite' | 'local';
  sandboxId: string | null;
  spriteTornDownAt: Date | null;
}

export interface PreviewAccessDeps {
  findSession(workspaceId: string): Promise<PreviewSessionRow | null>;
  findEnv(envId: string): Promise<PreviewEnvRow | null>;
  /** The requester's relationship to the DRIVE — the same resolver the session surface uses. */
  resolveDriveMembership(input: { userId: string; driveId: string }): Promise<DriveMembership>;
  /** The drive's payer, for the wake gate; null when the drive is gone (fail closed). */
  resolveDrivePayer(driveId: string): Promise<{ payerId: string } | null>;
  /** The centralized code-execution gate — consulted ONLY when a forward would be a wake. */
  canRunCode(input: { userId: string; driveId: string | null; ownerId: string }): Promise<CanRunCodeResult>;
  /** A control-plane attach to the holder's sprite; null when the platform no longer has it. Must not wake. */
  attach(sandboxId: string): Promise<SandboxHandle | null>;
  previewStore: DevPreviewStore;
  featureEnabled(): boolean;
  now(): Date;
}

export type PreviewAuthorization =
  | {
      allowed: true;
      /** The drive the holder lives in (null only for a global-assistant session). */
      driveId: string | null;
      /** Who pays for a wake — the input `canRunCode` needs. */
      wakeSubject: { driveId: string | null; ownerId: string };
      /** The holder's LIVE sprite name, or null when it has none right now. */
      sandboxId: string | null;
    }
  | { allowed: false; reason: string };

/**
 * May `userId` reach `holder`'s preview at all? Database facts only — the
 * same facts, through the same deciders, as the session routes and the env
 * routes. Never touches the control plane.
 */
export async function authorizePreviewHolder({
  holder,
  userId,
  deps,
}: {
  holder: DevPreviewHolderRef;
  userId: string;
  deps: Pick<PreviewAccessDeps, 'findSession' | 'findEnv' | 'resolveDriveMembership' | 'resolveDrivePayer'>;
}): Promise<PreviewAuthorization> {
  if (holder.kind === 'workspace') {
    const session = await deps.findSession(holder.id);
    if (!session) return { allowed: false, reason: 'session_not_found' };
    const driveMembership =
      session.driveId === null ? null : await deps.resolveDriveMembership({ userId, driveId: session.driveId });
    const decision = decideAgentSessionAccess({ requesterId: userId, session, driveMembership });
    if (!decision.allowed) return decision;
    // An ENDED session may not show a preview, and for an env-bound one that
    // has to be said: ending it kills nothing in the environment, so the
    // pointer below would still resolve (`resolveSessionSandboxHandle` draws
    // the same line for the file routes).
    if (session.endedAt !== null) return { allowed: false, reason: 'session_ended' };
    const env = session.envId === null ? null : await deps.findEnv(session.envId);
    if (session.envId !== null && env === null) return { allowed: false, reason: 'env_not_found' };
    // The wake is billed to the session's payer: the drive owner, or the
    // session owner for a global-assistant session — `canRunCode` resolves
    // that from (driveId, ownerId) exactly as a session ensure does.
    return {
      allowed: true,
      driveId: session.driveId,
      wakeSubject: { driveId: session.driveId, ownerId: session.ownerId },
      sandboxId: resolveLiveSandboxId(session, env),
    };
  }

  const env = await deps.findEnv(holder.id);
  if (!env) return { allowed: false, reason: 'env_not_found' };
  // A local env holds no sprite (CHECK-enforced); there is nothing to proxy.
  if (env.substrate !== 'sprite') return { allowed: false, reason: 'env_not_sprite' };
  const membership = await deps.resolveDriveMembership({ userId, driveId: env.driveId });
  // Any accepted member of the drive may VIEW an env's preview — the same bar
  // as the env routes' `isPrincipalDriveMember` GET gate. Spending the drive's
  // compute (a wake) is the stricter, separate question the wake gate asks.
  if (membership === 'none') return { allowed: false, reason: 'drive_access_denied' };
  const payer = await deps.resolveDrivePayer(env.driveId);
  if (!payer) return { allowed: false, reason: 'drive_not_found' };
  return {
    allowed: true,
    driveId: env.driveId,
    wakeSubject: { driveId: env.driveId, ownerId: payer.payerId },
    sandboxId: env.spriteTornDownAt === null ? env.sandboxId : null,
  };
}

export type PreviewTarget =
  | {
      decision: Extract<PreviewForwardDecision, { kind: 'forward' }>;
      authorization: Extract<PreviewAuthorization, { allowed: true }>;
      /** The sprite's URL from the control plane — the ONLY source of the upstream host. */
      spriteUrl: string;
      handle: SandboxHandle;
    }
  | {
      decision: Extract<PreviewForwardDecision, { kind: 'refuse' }>;
      authorization: PreviewAuthorization;
    };

/**
 * The whole gather for one request: authorize → attach (control plane) →
 * fold state → decide, consulting the wake gate only if asked. The returned
 * `decision` is never `needs-wake-gate`; that loop is closed here.
 */
export async function resolvePreviewTarget({
  holder,
  userId,
  deps,
}: {
  holder: DevPreviewHolderRef;
  userId: string;
  deps: PreviewAccessDeps;
}): Promise<PreviewTarget> {
  const featureEnabled = deps.featureEnabled();
  const authorization = await authorizePreviewHolder({ holder, userId, deps });
  const authz: PreviewAuthz = authorization.allowed ? { allowed: true } : authorization;

  // A refused user, or a dark feature, gets its answer from rows alone.
  const early = decidePreviewForward({ featureEnabled, authz, state: null, power: null, wakeAuthorization: 'not-consulted' });
  if (early.kind === 'refuse' && (early.reason === 'feature-disabled' || early.reason === 'not-authorized')) {
    return { decision: early, authorization };
  }
  if (!authorization.allowed) return { decision: { kind: 'refuse', reason: 'not-authorized', status: 404, message: 'Not found', detail: authorization.reason }, authorization };

  const handle = authorization.sandboxId === null ? null : await deps.attach(authorization.sandboxId);
  if (handle === null) {
    return { decision: decidePreviewForward({ featureEnabled, authz, state: null, power: null, wakeAuthorization: 'not-consulted' }) as Extract<PreviewForwardDecision, { kind: 'refuse' }>, authorization };
  }

  const [row, relay, power, urlInfo] = await Promise.all([
    deps.previewStore.findByHolder(holder),
    handle.services.get(PREVIEW_RELAY_SERVICE_NAME),
    handle.powerState(),
    handle.urlInfo(),
  ]);
  const state = describeServiceState({ liveInstanceId: handle.spriteInstanceId, row, relay, listeners: null });

  let decision = decidePreviewForward({ featureEnabled, authz, state, power, wakeAuthorization: 'not-consulted' });
  if (decision.kind === 'needs-wake-gate') {
    const wakeAuthorization = await deps.canRunCode({ userId, ...authorization.wakeSubject });
    decision = decidePreviewForward({ featureEnabled, authz, state, power, wakeAuthorization });
  }
  if (decision.kind !== 'forward') {
    return { decision: decision as Extract<PreviewForwardDecision, { kind: 'refuse' }>, authorization };
  }
  if (urlInfo.url === null) {
    return { decision: { kind: 'refuse', reason: 'preview-down', status: 502, message: 'The sandbox reports no inbound URL.' }, authorization };
  }
  // The sprite URL must be org-token-only. `'unknown'` is not proven private
  // and `'public'` is a state v1 never sets; either way, refusing to forward
  // is safer than proxying to a URL whose auth posture we cannot vouch for.
  if (urlInfo.auth !== 'sprite') {
    return { decision: { kind: 'refuse', reason: 'preview-down', status: 502, message: 'The sandbox URL is not in the expected private mode.' }, authorization };
  }
  return { decision, authorization, spriteUrl: urlInfo.url, handle };
}
