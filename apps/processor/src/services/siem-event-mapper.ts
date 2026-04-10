import type { AuditLogEntry } from './siem-adapter';

/**
 * Map a raw activity_logs database row to the AuditLogEntry type
 * consumed by the SIEM adapter.
 */
export function mapActivityLogToSiemEntry(row: Record<string, unknown>): AuditLogEntry {
  const rawTimestamp = row.timestamp;
  const timestamp = rawTimestamp instanceof Date ? rawTimestamp : new Date(rawTimestamp as string);

  return {
    id: row.id as string,
    timestamp,
    userId: (row.userId as string | null) ?? null,
    actorEmail: row.actorEmail as string,
    actorDisplayName: (row.actorDisplayName as string | null) ?? null,
    isAiGenerated: row.isAiGenerated as boolean,
    aiProvider: (row.aiProvider as string | null) ?? null,
    aiModel: (row.aiModel as string | null) ?? null,
    aiConversationId: (row.aiConversationId as string | null) ?? null,
    operation: String(row.operation),
    resourceType: String(row.resourceType),
    resourceId: row.resourceId as string,
    resourceTitle: (row.resourceTitle as string | null) ?? null,
    driveId: (row.driveId as string | null) ?? null,
    pageId: (row.pageId as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    previousLogHash: (row.previousLogHash as string | null) ?? null,
    logHash: (row.logHash as string | null) ?? null,
  };
}

/**
 * Map a batch of activity_logs rows to AuditLogEntry[]
 */
export function mapActivityLogsToSiemEntries(rows: Record<string, unknown>[]): AuditLogEntry[] {
  return rows.map(mapActivityLogToSiemEntry);
}
