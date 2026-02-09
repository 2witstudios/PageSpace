import { and, lt, eq, isNotNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  sessions,
  verificationTokens,
  socketTokens,
  emailUnsubscribeTokens,
  pageVersions,
  driveBackups,
  aiUsageLogs,
} from '@pagespace/db';
import { pagePermissions } from '@pagespace/db';
import { pulseSummaries } from '@pagespace/db';

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

export async function runRetentionCleanup(database: DB): Promise<CleanupResult[]> {
  const results = await Promise.all([
    cleanupExpiredSessions(database),
    cleanupExpiredVerificationTokens(database),
    cleanupExpiredSocketTokens(database),
    cleanupExpiredEmailUnsubscribeTokens(database),
    cleanupExpiredPulseSummaries(database),
    cleanupExpiredPageVersions(database),
    cleanupExpiredDriveBackups(database),
    cleanupExpiredPagePermissions(database),
    cleanupExpiredAiUsageLogs(database),
  ]);
  return results;
}
