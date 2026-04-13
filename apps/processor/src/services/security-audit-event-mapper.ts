import type { AuditLogEntry } from './siem-adapter';

/**
 * Shape of a row returned by the SIEM delivery worker's security_audit_log SELECT.
 *
 * Mirrors the columns of the `security_audit_log` table in
 * packages/db/src/schema/security-audit.ts. Kept narrow so the mapper stays a
 * pure function of database rows, with no dependency on Drizzle types.
 */
export interface SecurityAuditSiemRow {
  id: string;
  timestamp: Date | string;
  eventType: string;
  userId: string | null;
  sessionId: string | null;
  serviceId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  geoLocation: string | null;
  details: Record<string, unknown> | null;
  riskScore: number | null;
  anomalyFlags: string[] | null;
  previousHash: string | null;
  eventHash: string | null;
}

/**
 * Map a raw security_audit_log database row to the unified AuditLogEntry shape
 * consumed by the SIEM adapter.
 *
 * security_audit_log carries forensic context that activity_logs lacks
 * (sessionId, ipAddress, userAgent, geoLocation, riskScore, anomalyFlags). Those
 * are folded into `metadata` so the existing webhook/syslog formatters can ship
 * them without growing the AuditLogEntry surface.
 */
export function mapSecurityAuditToSiemEntry(row: SecurityAuditSiemRow): AuditLogEntry {
  const timestamp = row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Invalid security_audit_log timestamp for SIEM delivery: ${row.id}`);
  }

  const metadata: Record<string, unknown> = {};
  if (row.details !== null) metadata.details = row.details;
  if (row.sessionId !== null) metadata.sessionId = row.sessionId;
  if (row.serviceId !== null) metadata.serviceId = row.serviceId;
  if (row.ipAddress !== null) metadata.ipAddress = row.ipAddress;
  if (row.userAgent !== null) metadata.userAgent = row.userAgent;
  if (row.geoLocation !== null) metadata.geoLocation = row.geoLocation;
  if (row.riskScore !== null) metadata.riskScore = row.riskScore;
  if (row.anomalyFlags !== null) metadata.anomalyFlags = row.anomalyFlags;

  return {
    id: row.id,
    source: 'security_audit_log',
    timestamp,
    userId: row.userId ?? null,
    actorEmail: '-',
    actorDisplayName: null,
    isAiGenerated: false,
    aiProvider: null,
    aiModel: null,
    aiConversationId: null,
    operation: row.eventType,
    resourceType: row.resourceType ?? 'security_audit_log',
    resourceId: row.resourceId ?? row.id,
    resourceTitle: null,
    driveId: null,
    pageId: null,
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
    previousLogHash: row.previousHash ?? null,
    logHash: row.eventHash ?? null,
  };
}

/**
 * Map a batch of security_audit_log rows to AuditLogEntry[]
 */
export function mapSecurityAuditEventsToSiemEntries(
  rows: SecurityAuditSiemRow[]
): AuditLogEntry[] {
  return rows.map(mapSecurityAuditToSiemEntry);
}
