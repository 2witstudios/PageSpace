/**
 * Test helper: read an org event back out of the chain entry the outbox appends (org-audit.ts), so a suite that
 * captures `securityAudit.logEvent` sees the event its code staged — orgId and driveId lifted back out of details.
 */
import type { AuditEvent } from '../security-audit';

export type CapturedOrgEvent = {
  orgId: string;
  driveId?: string;
  eventType: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
};

export function orgEventOf(entry: AuditEvent): CapturedOrgEvent {
  const { orgId, driveId, ...details } = (entry.details ?? {}) as Record<string, unknown>;
  return {
    orgId: String(orgId),
    ...(typeof driveId === 'string' ? { driveId } : {}),
    eventType: entry.eventType,
    ...(entry.userId ? { actorId: entry.userId } : {}),
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}
