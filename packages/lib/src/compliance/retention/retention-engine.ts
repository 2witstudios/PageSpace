import { and, lt, eq, isNotNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { verificationTokens, socketTokens, emailUnsubscribeTokens } from '@pagespace/db/schema/auth';
import { pulseSummaries } from '@pagespace/db/schema/dashboard';
import { pagePermissions } from '@pagespace/db/schema/members';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { sessions } from '@pagespace/db/schema/sessions';
import { pageVersions, driveBackups } from '@pagespace/db/schema/versioning';
import { messages, conversations } from '@pagespace/db/schema/conversations';
import { aiStreamFrames } from '@pagespace/db/schema/ai-streams';
import { runMonitoringRetentionCleanup } from './monitoring-retention';
import {
  resolveChatRetentionDays,
  computeChatRetentionCutoff,
} from './chat-retention';

export interface CleanupResult {
  table: string;
  deleted: number;
}

type DB = NodePgDatabase<Record<string, unknown>>;

export async function cleanupExpiredSessions(database: DB): Promise<CleanupResult> {
  const now = new Date();
  const result = await database
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return { table: 'sessions', deleted: result.length };
}

export async function cleanupExpiredVerificationTokens(database: DB): Promise<CleanupResult> {
  const now = new Date();
  const result = await database
    .delete(verificationTokens)
    .where(lt(verificationTokens.expiresAt, now))
    .returning({ id: verificationTokens.id });
  return { table: 'verification_tokens', deleted: result.length };
}

export async function cleanupExpiredSocketTokens(database: DB): Promise<CleanupResult> {
  const now = new Date();
  const result = await database
    .delete(socketTokens)
    .where(lt(socketTokens.expiresAt, now))
    .returning({ id: socketTokens.id });
  return { table: 'socket_tokens', deleted: result.length };
}

export async function cleanupExpiredEmailUnsubscribeTokens(database: DB): Promise<CleanupResult> {
  const now = new Date();
  const result = await database
    .delete(emailUnsubscribeTokens)
    .where(lt(emailUnsubscribeTokens.expiresAt, now))
    .returning({ id: emailUnsubscribeTokens.id });
  return { table: 'email_unsubscribe_tokens', deleted: result.length };
}

export async function cleanupExpiredPulseSummaries(database: DB): Promise<CleanupResult> {
  const now = new Date();
  const result = await database
    .delete(pulseSummaries)
    .where(lt(pulseSummaries.expiresAt, now))
    .returning({ id: pulseSummaries.id });
  return { table: 'pulse_summaries', deleted: result.length };
}

export async function cleanupExpiredPageVersions(database: DB): Promise<CleanupResult> {
  const now = new Date();
  const result = await database
    .delete(pageVersions)
    .where(
      and(
        lt(pageVersions.expiresAt, now),
        eq(pageVersions.isPinned, false)
      )
    )
    .returning({ id: pageVersions.id });
  return { table: 'page_versions', deleted: result.length };
}

export async function cleanupExpiredDriveBackups(database: DB): Promise<CleanupResult> {
  const now = new Date();
  const result = await database
    .delete(driveBackups)
    .where(
      and(
        lt(driveBackups.expiresAt, now),
        eq(driveBackups.isPinned, false)
      )
    )
    .returning({ id: driveBackups.id });
  return { table: 'drive_backups', deleted: result.length };
}

export async function cleanupExpiredPagePermissions(database: DB): Promise<CleanupResult> {
  const now = new Date();
  const result = await database
    .delete(pagePermissions)
    .where(
      and(
        isNotNull(pagePermissions.expiresAt),
        lt(pagePermissions.expiresAt, now)
      )
    )
    .returning({ id: pagePermissions.id });
  return { table: 'page_permissions', deleted: result.length };
}

export async function cleanupExpiredAiUsageLogs(database: DB): Promise<CleanupResult> {
  const now = new Date();
  const result = await database
    .delete(aiUsageLogs)
    .where(
      and(
        isNotNull(aiUsageLogs.expiresAt),
        lt(aiUsageLogs.expiresAt, now)
      )
    )
    .returning({ id: aiUsageLogs.id });
  return { table: 'ai_usage_logs', deleted: result.length };
}

/**
 * Hard-delete soft-deleted AI chat records (page-agent chat messages, global/
 * channel messages, and conversations) older than the chat retention window
 * (#974). Soft-deleted (`isActive=false`) rows have no operational need; keeping
 * them indefinitely over-retains personal data. The window is configurable via
 * RETENTION_CHAT_SOFT_DELETE_DAYS (default 30 days). Active conversations are
 * never touched.
 *
 * Each table is aged by the timestamp that best reflects when the grace period
 * should start, matching the existing purge helpers:
 *  - conversations: `updatedAt` ($onUpdate bumps it on the soft-delete write),
 *    so a long-lived conversation deleted today still gets its full grace period.
 *  - messages: `createdAt` (the table carries no soft-delete timestamp;
 *    `editedAt` is only set on content edits). This matches the existing
 *    `purgeInactiveMessages` semantics.
 *
 * ── CASCADE (migrations 0249/0250) ─────────────────────────────────────────
 * The `conversations` delete below is not a leaf. Two FKs cascade from it:
 * `messages.conversationId` (always did) and `ai_stream_sessions
 * .conversation_id` (0250). Purging one soft-deleted conversation therefore
 * also purges its per-generation stream checkpoints — message CONTENT
 * (`parts`) that nothing in this codebase had ever deleted before 0250. That
 * is strictly MORE deletion than before, and it is the intended direction:
 * retention's whole job is that nothing outlives its window. (A third cascade,
 * `chat_messages.conversationId` from 0249, went with that table when Phase 4
 * PR 15 dropped it.)
 *
 * The two statements are consequently NOT independent, which is why the
 * conversations sweep runs AFTER the message sweep rather than alongside it:
 * two concurrent DELETEs whose row sets overlap (the direct sweep and the
 * cascade) can lock the same `messages` rows in different orders, and a
 * deadlock aborts the retention run. Sequencing the cascading statement last
 * costs one round trip and removes that class entirely. It also makes the
 * reported counts stable: the message sweep reports what age-based sweeping
 * removed, and whatever the cascade mops up afterwards was, by construction,
 * already condemned.
 */
export async function cleanupSoftDeletedChatRecords(database: DB): Promise<CleanupResult[]> {
  const cutoff = computeChatRetentionCutoff(
    new Date(),
    resolveChatRetentionDays(process.env.RETENTION_CHAT_SOFT_DELETE_DAYS),
  );

  const globalMsgs = await database
    .delete(messages)
    .where(and(eq(messages.isActive, false), lt(messages.createdAt, cutoff)))
    .returning({ id: messages.id });

  // Cascades into messages and ai_stream_sessions — sequenced last.
  const convos = await database
    .delete(conversations)
    .where(and(eq(conversations.isActive, false), lt(conversations.updatedAt, cutoff)))
    .returning({ id: conversations.id });

  return [
    { table: 'messages', deleted: globalMsgs.length },
    { table: 'conversations', deleted: convos.length },
  ];
}

/**
 * How long an AI stream's raw frames may survive without anything having claimed them.
 *
 * `ai_stream_frames` is normally self-clearing: the writer deletes a message's log the moment
 * a terminal `messages` row for it is confirmed (the generation's own save, or a crash
 * recovery's materialization). This sweep is the BACKSTOP for the case where neither ran at
 * all — the owning process died before it could save, and nothing has since polled, sent, or
 * stopped anything on that conversation to trigger a recovery. Without it those frames are
 * message CONTENT sitting in a table with no reader and no expiry.
 *
 * 24 hours, chosen against the recovery path rather than picked round. A row is judged dead
 * and materialized well inside two hours (`RECONCILE_BACKSTOP_MS`, stream-liveness.ts — twice
 * the one-hour stream lifetime horizon), but only when something looks: a client polling
 * `/active-streams`, the next send's takeover, a Stop. That trigger can be arbitrarily
 * delayed — a user who closes the tab on a crashed stream and comes back tomorrow. A day of
 * headroom means such a recovery still folds the real frames; past it the recovery still
 * happens, just from the `parts` snapshot, which is the documented fallback. The daily cron
 * cadence makes the effective window 24-48h.
 *
 * Aged per ROW, on `created_at`, which is the table's only index and the only column that can
 * be swept without a join. For a stream still running after a full day this could in
 * principle age out its early batches while later ones survive — leaving a log that no longer
 * starts at seq 0. That is safe rather than corrupting: the reader requires a contiguous
 * prefix from seq 0 and answers "no log" otherwise, so such a stream degrades to the `parts`
 * fallback instead of replaying a message missing its beginning.
 */
const STREAM_FRAME_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function cleanupAbandonedStreamFrames(database: DB): Promise<CleanupResult> {
  const cutoff = new Date(Date.now() - STREAM_FRAME_RETENTION_MS);
  const result = await database
    .delete(aiStreamFrames)
    .where(lt(aiStreamFrames.createdAt, cutoff))
    .returning({ messageId: aiStreamFrames.messageId });
  return { table: 'ai_stream_frames', deleted: result.length };
}

export async function runRetentionCleanup(database: DB): Promise<CleanupResult[]> {
  const [expiryResults, chatResults, monitoringResults] = await Promise.all([
    Promise.all([
      cleanupExpiredSessions(database),
      cleanupExpiredVerificationTokens(database),
      cleanupExpiredSocketTokens(database),
      cleanupExpiredEmailUnsubscribeTokens(database),
      cleanupExpiredPulseSummaries(database),
      cleanupExpiredPageVersions(database),
      cleanupExpiredDriveBackups(database),
      cleanupExpiredPagePermissions(database),
      cleanupExpiredAiUsageLogs(database),
      cleanupAbandonedStreamFrames(database),
    ]),
    cleanupSoftDeletedChatRecords(database),
    runMonitoringRetentionCleanup(),
  ]);
  return [...expiryResults, ...chatResults, ...monitoringResults];
}
