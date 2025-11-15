/**
 * Database writer for Audit Logger
 * Handles writing audit log entries to the database
 */

import { db, auditLogs } from '@pagespace/db';
import type { AuditLogEntry } from './audit-logger';

/**
 * Convert audit log entry to database format
 */
function convertToDbFormat(entry: AuditLogEntry) {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    action: entry.action,
    category: entry.category,
    userId: entry.userId,
    userEmail: entry.userEmail,
    actorType: entry.actorType,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    resourceName: entry.resourceName,
    driveId: entry.driveId,
    pageId: entry.pageId,
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    ip: entry.ip,
    userAgent: entry.userAgent,
    endpoint: entry.endpoint,
    changes: entry.changes,
    metadata: entry.metadata,
    success: entry.success,
    errorMessage: entry.errorMessage,
    anonymized: entry.anonymized,
    retentionDate: entry.retentionDate,
    service: entry.service,
    version: entry.version,
  };
}

/**
 * Write audit log entries to database
 */
export async function writeAuditLogs(entries: AuditLogEntry[]): Promise<void> {
  if (entries.length === 0) return;

  try {
    const dbEntries = entries.map(convertToDbFormat);

    // Batch insert
    await db.insert(auditLogs).values(dbEntries);

    // Log successful write (only in debug mode to avoid noise)
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[AuditLogger] Successfully wrote ${entries.length} audit entries to database`);
    }
  } catch (error) {
    // Don't fallback to console for audit logs - they need to be in the database
    // Throw error so retry logic can handle it
    throw new Error(`Failed to write audit logs to database: ${(error as Error).message}`);
  }
}
