/**
 * Org audit events (Spec AUD-1, AUD-2): one writer through the existing security audit chain. There is no
 * new table; an org event is an ordinary chain row whose `details.orgId` is the org dimension.
 *
 * The write is AWAITED, so a caller sees a rejected append, and it is the same dual write as audit()
 * (structured log, then the chain). Details carry ids and counts, never content or names.
 */
import type { SecurityEventType } from '@pagespace/db/schema/security-audit';
import { loggers } from '../logging/logger-config';
import { securityAudit } from './security-audit';

export type OrgAuditEventType = Extract<SecurityEventType, `org.${string}`>;

export interface OrgAuditEvent {
  orgId: string;
  eventType: OrgAuditEventType;
  /** The person who acted; omitted for system actions. */
  actorId?: string;
  resourceType: string;
  resourceId: string;
  /** Set when the event concerns one drive, so the log filters by drive. */
  driveId?: string;
  details?: Record<string, unknown>;
}

export async function recordOrgAuditEvent(event: OrgAuditEvent): Promise<void> {
  const entry = {
    eventType: event.eventType,
    userId: event.actorId,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    // orgId and driveId are written last so a caller's details can never overwrite the dimensions.
    details: { ...event.details, orgId: event.orgId, ...(event.driveId ? { driveId: event.driveId } : {}) },
  };
  loggers.security.info(`[Audit] ${entry.eventType}`, { ...entry });
  await securityAudit.logEvent(entry);
}
