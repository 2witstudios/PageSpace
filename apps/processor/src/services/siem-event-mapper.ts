import type { AuditLogEntry } from './siem-adapter';

/** Shape of a row returned by the SIEM delivery worker's activity_logs SELECT */
export interface ActivityLogSiemRow {
  id: string;
  timestamp: Date | string;
  userId: string | null;
  actorEmail: string;
  actorDisplayName: string | null;
  isAiGenerated: boolean;
  aiProvider: string | null;
  aiModel: string | null;
  aiConversationId: string | null;
  operation: string;
  resourceType: string;
  resourceId: string;
  resourceTitle: string | null;
  driveId: string | null;
  pageId: string | null;
  metadata: Record<string, unknown> | null;
  previousLogHash: string | null;
  logHash: string | null;
}

/**
 * Map a raw activity_logs database row to the AuditLogEntry type
 * consumed by the SIEM adapter.
 */
export function mapActivityLogToSiemEntry(row: ActivityLogSiemRow): AuditLogEntry {
  const timestamp = row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Invalid activity_logs timestamp for SIEM delivery: ${row.id}`);
  }

  return {
    id: row.id,
    source: 'activity_logs',
    timestamp,
    userId: row.userId ?? null,
    actorEmail: row.actorEmail,
    actorDisplayName: row.actorDisplayName ?? null,
    isAiGenerated: row.isAiGenerated,
    aiProvider: row.aiProvider ?? null,
    aiModel: row.aiModel ?? null,
    aiConversationId: row.aiConversationId ?? null,
    operation: String(row.operation),
    resourceType: String(row.resourceType),
    resourceId: row.resourceId,
    resourceTitle: row.resourceTitle ?? null,
    driveId: row.driveId ?? null,
    pageId: row.pageId ?? null,
    metadata: row.metadata ?? null,
    previousLogHash: row.previousLogHash ?? null,
    logHash: row.logHash ?? null,
  };
}

/**
 * Map a batch of activity_logs rows to AuditLogEntry[]
 */
export function mapActivityLogsToSiemEntries(rows: ActivityLogSiemRow[]): AuditLogEntry[] {
  return rows.map(mapActivityLogToSiemEntry);
}
