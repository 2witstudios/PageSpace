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

/**
 * For a mutation that has ALREADY committed: write its org event, and if the chain refuses the append,
 * log it loudly and report false instead of failing a change that has happened. Callers that can still
 * refuse the change (before commit) use recordOrgAuditEvent and let it throw.
 */
export async function recordOrgAuditEventAfterCommit(event: OrgAuditEvent): Promise<boolean> {
  try {
    await recordOrgAuditEvent(event);
    return true;
  } catch (error) {
    loggers.security.error('[Audit] org event was not recorded after its change committed', {
      eventType: event.eventType,
      orgId: event.orgId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
