/**
 * Kick users from agent-run Socket.IO rooms when access to the underlying
 * conversation context (page or drive) is revoked.
 *
 * Agent runs live under conversations, which are scoped to a page, a drive, or
 * globally. When a user loses access to a page or drive, any `agent-run:${runId}`
 * room they joined via that conversation must be evicted — otherwise the
 * long-lived socket keeps streaming `agent_run_event` broadcasts after the
 * authorization gate has closed.
 */

import {
  db,
  eq,
  and,
  or,
  inArray,
  agentRuns,
  conversations,
  pages,
} from '@pagespace/db';
import { kickUserFromRooms, type KickReason, type KickResult } from './socket-utils';

export async function kickUserFromAgentRun(
  runId: string,
  userId: string,
  reason: KickReason,
): Promise<KickResult> {
  return kickUserFromRooms({
    userId,
    roomPattern: `agent-run:${runId}`,
    reason,
  });
}

export async function kickUserFromAgentRunsForPage(
  pageId: string,
  userId: string,
  reason: KickReason,
): Promise<void> {
  const runs = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(conversations, eq(conversations.id, agentRuns.conversationId))
    .where(and(eq(conversations.type, 'page'), eq(conversations.contextId, pageId)));

  if (runs.length === 0) return;
  await Promise.all(runs.map((r) => kickUserFromAgentRun(r.id, userId, reason)));
}

export async function kickUserFromAgentRunsForDrive(
  driveId: string,
  userId: string,
  reason: KickReason,
): Promise<void> {
  const drivePageIds = db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, driveId));

  const runs = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(conversations, eq(conversations.id, agentRuns.conversationId))
    .where(
      or(
        and(eq(conversations.type, 'drive'), eq(conversations.contextId, driveId)),
        and(eq(conversations.type, 'page'), inArray(conversations.contextId, drivePageIds)),
      ),
    );

  if (runs.length === 0) return;
  await Promise.all(runs.map((r) => kickUserFromAgentRun(r.id, userId, reason)));
}
