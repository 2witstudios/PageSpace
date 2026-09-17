/**
 * Production wiring for `POST /api/agent-workspaces/[workspaceId]/exec` — the
 * token-reachable shell surface the CLI/SDK drive.
 *
 * It is the chat `bash` tool with a different ADDRESS, not a second execution
 * path: the same `productionSandboxGate`, the same `runBashInSandbox`, and the
 * same `buildRealSandboxRunDeps` — only the session resolver is swapped for the
 * row the route already authorized, so provisioning, billing, quota and audit
 * all key on exactly the workspace the caller named.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import {
  runBashInSandbox,
  type BashToolResult,
  type SandboxActorContext,
} from '@pagespace/lib/services/sandbox/tool-runners';
import type { AgentSessionRecord } from '@pagespace/lib/services/agent-workspaces/agent-workspaces-store';
import { buildRealSandboxRunDeps, productionSandboxGate } from '@/lib/ai/tools/sandbox-tools-runtime';

/** The opaque conversation scope key an exec run carries (it has no chat conversation). */
const workspaceExecScopeKey = (workspaceId: string): string => `workspace-exec:${workspaceId}`;

/**
 * The actor context for an exec against `session`, mirroring
 * `createResolveSandboxActorContext`'s BOUND-SESSION branch: the payer is the
 * session's drive owner, or the session's own owner when it is driveless — and
 * the quota tier is the PAYER's, never the acting user's.
 */
export async function resolveWorkspaceExecActorContext(
  session: AgentSessionRecord,
  userId: string,
): Promise<SandboxActorContext | { error: string }> {
  const [drive, actorInfo] = await Promise.all([
    session.driveId
      ? db.query.drives.findFirst({ where: eq(drives.id, session.driveId), columns: { ownerId: true } })
      : Promise.resolve(undefined),
    getActorInfo(userId),
  ]);
  if (session.driveId && !drive) return { error: 'Code execution requires an active drive.' };

  const payerId = drive?.ownerId ?? session.ownerId;
  const payer = await db.query.users.findFirst({
    where: eq(users.id, payerId),
    columns: { subscriptionTier: true },
  });

  return {
    userId,
    tenantId: drive?.ownerId ?? session.ownerId,
    ...(session.driveId ? { driveId: session.driveId } : {}),
    ownerId: session.ownerId,
    conversationId: workspaceExecScopeKey(session.id),
    requestOrigin: 'user',
    actorEmail: actorInfo.actorEmail,
    actorDisplayName: actorInfo.actorDisplayName,
    tier: toSubscriptionTier(payer?.subscriptionTier),
  };
}

type WorkspaceExecResult =
  | BashToolResult
  | { success: false; error: string; reason: string; retryAfter?: number };

/** Gate, then run `command` in the workspace's sandbox (provisioning it on first use). */
export async function execInWorkspace(input: {
  session: AgentSessionRecord;
  ctx: SandboxActorContext;
  command: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<WorkspaceExecResult> {
  const decision = await productionSandboxGate(input.ctx);
  if (!decision.ok) {
    return {
      success: false,
      error: decision.error,
      reason: decision.reason,
      ...(decision.retryAfter ? { retryAfter: decision.retryAfter } : {}),
    };
  }
  const { session } = input;
  return runBashInSandbox({
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    ctx: input.ctx,
    deps: buildRealSandboxRunDeps({ resolveSession: async () => ({ ok: true, session }) }),
  });
}
