import { and, lt, eq, isNotNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { verificationTokens, socketTokens, emailUnsubscribeTokens } from '@pagespace/db/schema/auth';
import { pulseSummaries } from '@pagespace/db/schema/dashboard';
import { pagePermissions } from '@pagespace/db/schema/members';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { sessions } from '@pagespace/db/schema/sessions';
import { pageVersions, driveBackups } from '@pagespace/db/schema/versioning';
import { chatMessages } from '@pagespace/db/schema/core';
import { messages, conversations } from '@pagespace/db/schema/conversations';
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
 *  - messages / chat_messages: `createdAt` (these tables carry no soft-delete
 *    timestamp; `editedAt` is only set on content edits). This matches the
 *    existing `purgeInactiveMessages` semantics.
 *
 * ── BOTH MESSAGE LEGS, DELIBERATELY (epic "Agent-Session Single Source of
 *    Truth", Phase 4 / D6) ────────────────────────────────────────────────
 * `chat_messages` is being merged into `messages`, and the GDPR EXPORT has
 * already cut over to reading the unified table alone (it is a superset, so
 * reading both would duplicate rows). RETENTION MUST NOT FOLLOW IT. While
 * rows physically exist in `chat_messages`, a table this sweep stops naming
 * is a table whose soft-deleted personal data is retained forever. The legacy
 * leg may be removed ONLY by Phase 4 PR 15, in the same change that runs
 * `DROP TABLE chat_messages` — see
 * `packages/lib/src/compliance/__tests__/message-unification-compliance-legs.test.ts`,
 * which fails if it disappears earlier.
 *
 * ── CASCADE (migrations 0248/0249) ─────────────────────────────────────────
 * The `conversations` delete below is no longer a leaf. Three FKs now cascade
 * from it: `messages.conversationId` (always did), `chat_messages
 * .conversationId` (0248, NOT VALID — the referential triggers still fire, so
 * it cascades for every row that names a real conversation), and
 * `ai_stream_sessions.conversation_id` (0249). Purging one soft-deleted
 * conversation therefore now also purges its legacy page-chat rows and its
 * per-generation stream checkpoints — the latter being message CONTENT
 * (`parts`) that nothing in this codebase has ever deleted. That is strictly
 * MORE deletion than before, and it is the intended direction: retention's
 * whole job is that nothing outlives its window.
 *
 * The three statements are consequently NO LONGER independent, which is why
 * the conversations sweep runs AFTER the two message legs rather than
 * alongside them: two concurrent DELETEs whose row sets overlap (the direct
 * sweep and the cascade) can lock the same `chat_messages`/`messages` rows in
 * different orders, and a deadlock aborts the retention run. Sequencing the
 * cascading statement last costs one round trip and removes that class
 * entirely. It also makes the reported counts stable: the message legs report
 * what age-based sweeping removed, and whatever the cascade mops up
 * afterwards was, by construction, already condemned.
 */
export async function cleanupSoftDeletedChatRecords(database: DB): Promise<CleanupResult[]> {
  const cutoff = computeChatRetentionCutoff(
    new Date(),
    resolveChatRetentionDays(process.env.RETENTION_CHAT_SOFT_DELETE_DAYS),
  );

  // Both message legs, in parallel: different tables, disjoint row sets.
  const [chatMsgs, globalMsgs] = await Promise.all([
    // THE LEGACY LEG. Removable only by Phase 4 PR 15 (see the doc above).
    database
      .delete(chatMessages)
      .where(and(eq(chatMessages.isActive, false), lt(chatMessages.createdAt, cutoff)))
      .returning({ id: chatMessages.id }),
    // The unified leg.
    database
      .delete(messages)
      .where(and(eq(messages.isActive, false), lt(messages.createdAt, cutoff)))
      .returning({ id: messages.id }),
  ]);

  // Cascades into both message tables and ai_stream_sessions — sequenced last.
  const convos = await database
    .delete(conversations)
    .where(and(eq(conversations.isActive, false), lt(conversations.updatedAt, cutoff)))
    .returning({ id: conversations.id });

  return [
    { table: 'chat_messages', deleted: chatMsgs.length },
    { table: 'messages', deleted: globalMsgs.length },
    { table: 'conversations', deleted: convos.length },
  ];
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
    ]),
    cleanupSoftDeletedChatRecords(database),
    runMonitoringRetentionCleanup(),
  ]);
  return [...expiryResults, ...chatResults, ...monitoringResults];
}
