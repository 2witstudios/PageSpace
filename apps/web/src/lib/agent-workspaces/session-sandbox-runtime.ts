/**
 * Production wiring for the session Files/Diff/Git-Blob routes: resolve a
 * session's LIVE sandbox handle, and bind `runGitInSandbox`'s deps directly to
 * it (the session already holds its own live handle, so `acquireSandbox` is a
 * constant and `reconnect` adapts the handle — the exact DI shape
 * `machine-git-blob-runtime.ts` uses for branch terminals).
 *
 * Resolution NEVER provisions: a browsing surface must not mint (or wake into
 * existence) a VM to answer "what files are there". A session that has no
 * sandbox yet answers `not_started`; a recorded Sprite the platform no longer
 * knows answers `vanished`. Result unions only — routes map, never catch.
 */

import { adaptSandboxHandleToExecutableSandbox } from '@pagespace/lib/services/sandbox/sandbox-client/sandbox-host-adapter';
import type { GitSandboxRunDeps } from '@pagespace/lib/services/sandbox/git-tool-runners';
import type { SandboxActorContext } from '@pagespace/lib/services/sandbox/tool-runners';
import { defaultBuildEnv } from '@pagespace/lib/services/sandbox/tool-runners';
import type { SandboxHandle } from '@pagespace/lib/services/sandbox/sandbox-host';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { resolveGitHubTokenForSandbox } from '@pagespace/lib/services/sandbox/github-token';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
} from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { findSessionRecord, getSandboxHost } from './agent-sessions-runtime';

export type ResolveSessionSandboxHandleResult =
  | { ok: true; handle: SandboxHandle }
  /** `not_started` = the session never acquired a sandbox (or it was ended); `vanished` = it recorded one the platform no longer has. */
  | { ok: false; reason: 'not_found' | 'not_started' | 'vanished' };

/** Attach (never provision) to a session's recorded Sprite. */
export async function resolveSessionSandboxHandle(
  workspaceId: string,
): Promise<ResolveSessionSandboxHandleResult> {
  const session = await findSessionRecord(workspaceId);
  if (!session) return { ok: false, reason: 'not_found' };
  if (session.sandboxId === null || session.spriteTornDownAt !== null) {
    return { ok: false, reason: 'not_started' };
  }
  const host = await getSandboxHost();
  const handle = await host.attach({ sandboxId: session.sandboxId }).catch(() => null);
  if (!handle) return { ok: false, reason: 'vanished' };
  return { ok: true, handle };
}

export interface SessionActorContext {
  userId: string;
  tenantId: string;
  actorEmail: string;
  actorDisplayName?: string;
  tier: ReturnType<typeof toSubscriptionTier>;
}

/** The acting user's identity/tier facts for a git read run's actor context. */
export async function resolveSessionActorContext(userId: string): Promise<SessionActorContext> {
  const [user, actorInfo] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { subscriptionTier: true } }),
    getActorInfo(userId),
  ]);
  return {
    userId,
    tenantId: userId,
    actorEmail: actorInfo.actorEmail,
    actorDisplayName: actorInfo.actorDisplayName,
    tier: toSubscriptionTier(user?.subscriptionTier),
  };
}

/**
 * A session read op has no chat conversation of its own; the opaque scope key
 * satisfies `SandboxActorContext.conversationId` exactly as `buildActorCtx`
 * does for branch-terminal ops (machine-branches.ts).
 */
export function buildSessionReadActorCtx(scopeKey: string, actor: SessionActorContext): SandboxActorContext {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    driveId: undefined,
    conversationId: scopeKey,
    actorEmail: actor.actorEmail,
    actorDisplayName: actor.actorDisplayName,
    tier: actor.tier,
  };
}

/**
 * `runGitInSandbox` deps bound directly to an already-resolved session
 * `SandboxHandle` — no acquire/reconnect lookup (the handle IS the sandbox).
 * The session id rides the acquire result so the post-run hooks (storage
 * measurement) stay keyed by the session, same as the tool path.
 */
export function buildSessionGitDepsForHandle(handle: SandboxHandle, workspaceId: string): GitSandboxRunDeps {
  const sandbox = adaptSandboxHandleToExecutableSandbox(handle);
  return {
    isEnabled: isCodeExecutionEnabled,
    resolveGitHubToken: (userId: string) => resolveGitHubTokenForSandbox({ userId, db }),
    quota: { acquireSlot: acquireCodeExecutionSlot, releaseSlot: releaseCodeExecutionSlot },
    buildEnv: defaultBuildEnv,
    audit: (input) => writeCodeExecutionAudit({ input }),
    now: () => new Date(),
    acquireSandbox: async () => ({ ok: true, sandboxId: handle.sandboxId, resumed: false, workspaceId }),
    reconnect: async () => sandbox,
  };
}
