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
import { canRunCodeForSession } from '@pagespace/lib/services/agent-workspaces/agent-workspace-tenant';
import { findSessionRecord, getSandboxHost, resolveSessionLiveSandboxId } from './agent-workspaces-runtime';

export type ResolveSessionSandboxHandleResult =
  | { ok: true; handle: SandboxHandle }
  /**
   * `not_started` = the session never acquired a sandbox (or it was ended);
   * `vanished` = it recorded one the platform no longer has;
   * `not_authorized` = the requester may reach this session but may not spend
   * its compute (see below). All three answer the SAME on the wire — the
   * family policy this route surface already follows — but they are distinct
   * here so a caller can audit the one that is a denial rather than a state.
   */
  | { ok: false; reason: ResolveSessionSandboxHandleDenial };

/** The denial reasons, named so the routes' status/wire maps stay exhaustive by type. */
export type ResolveSessionSandboxHandleDenial = 'not_found' | 'not_started' | 'vanished' | 'not_authorized';

/**
 * Attach (never provision) to the machine a session's work runs on.
 *
 * **`requesterId` is REQUIRED, and this function applies the code-execution
 * gate itself.** `decideAgentSessionAccess` is deliberately capability-free —
 * the session SURFACE (list, detail, panes) is free to any drive member, and
 * every chokepoint that SPENDS COMPUTE consults `canRunCode` on its own
 * (`ensureAgentSessionSandbox`'s authorize seam, the tool gate, the realtime
 * shell-attach wiring). This is such a chokepoint and was missing from that
 * list: it hands back a live handle that the files, diff and git-blob routes
 * read AND WRITE through, and those routes gate on `checkSessionAccess` alone.
 *
 * That gap mattered little while the handle could only ever be a session's own
 * ephemeral sandbox. It matters a great deal now that an env-bound session
 * resolves the ENVIRONMENT's machine: the disk is shared by every session in
 * the drive and outlives all of them, so an un-gated write is a write into
 * other people's working tree, by someone the drive never granted compute to.
 */
export async function resolveSessionSandboxHandle(
  workspaceId: string,
  requesterId: string,
): Promise<ResolveSessionSandboxHandleResult> {
  const session = await findSessionRecord(workspaceId);
  if (!session) return { ok: false, reason: 'not_found' };
  // The capability gate, asked BEFORE anything about the machine is revealed.
  //
  // Through `canRunCodeForSession` rather than a hand-rolled `canRunCode` call,
  // because that helper is ALREADY the answer this session's GET returns as
  // `sandboxEligible` — the field the client uses to disable the Shell and
  // reattach controls for a requester who may not spend compute. Sharing it
  // means the server cannot enforce a different rule than the UI advertises,
  // and there is no second argument list to drift.
  //
  // Which is exactly what had gone wrong: `sandboxEligible`'s own docblock
  // names the enforcement points that back it — "shells POST, realtime attach"
  // — and these three browse routes were not among them. The UI hid the
  // controls; nothing stopped the request.
  const eligible = await canRunCodeForSession({
    userId: requesterId,
    driveId: session.driveId,
    ownerId: session.ownerId,
  });
  if (!eligible) return { ok: false, reason: 'not_authorized' };
  // An ENDED session may not touch a filesystem, and for an env-bound one that
  // has to be said out loud. An ordinary ended session is refused by the
  // pointer check below anyway — ending it stamps `spriteTornDownAt` — but
  // ending an env session deliberately kills nothing, so its environment is
  // still running and `resolveSessionLiveSandboxId` still answers with the
  // machine's address (which is correct: `killSessionShellById` needs it to
  // reach the PTYs that session left behind). Without this line the files,
  // diff and git-blob routes would keep READING AND WRITING a drive's shared
  // disk under a session the API itself reports as `'ended'`.
  if (session.endedAt !== null) return { ok: false, reason: 'not_started' };
  // WHICH row owns the machine is `resolveSessionLiveSandboxId`'s question: an
  // env-bound session's own pointer is CHECK-forbidden to be anything but null,
  // so reading it here would answer `not_started` for the session's whole life
  // — the file browser, the diff panel and the git-blob viewer all denying a
  // session whose environment is running.
  const sandboxId = await resolveSessionLiveSandboxId(session);
  if (sandboxId === null) return { ok: false, reason: 'not_started' };
  const host = await getSandboxHost();
  const handle = await host.attach({ sandboxId }).catch(() => null);
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
