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
 */
export async function cleanupSoftDeletedChatRecords(database: DB): Promise<CleanupResult[]> {
  const cutoff = computeChatRetentionCutoff(
    new Date(),
    resolveChatRetentionDays(process.env.RETENTION_CHAT_SOFT_DELETE_DAYS),
  );

  const [chatMsgs, globalMsgs, convos] = await Promise.all([
    database
      .delete(chatMessages)
      .where(and(eq(chatMessages.isActive, false), lt(chatMessages.createdAt, cutoff)))
      .returning({ id: chatMessages.id }),
    database
      .delete(messages)
      .where(and(eq(messages.isActive, false), lt(messages.createdAt, cutoff)))
      .returning({ id: messages.id }),
    database
      .delete(conversations)
      .where(and(eq(conversations.isActive, false), lt(conversations.updatedAt, cutoff)))
      .returning({ id: conversations.id }),
  ]);

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
