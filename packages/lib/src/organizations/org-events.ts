/**
 * Org audit events that several mutations share (Spec AUD-1). Each is STAGED in the transaction of the change it
 * describes (the outbox, audit/org-audit.ts) and published by the caller after commit, so an event exists exactly
 * when its change does.
 */
import { stageOrgAuditEvents, type OrgAuditEvent, type OrgAuditExecutor, type StagedOrgAuditEvent } from '../audit/org-audit';
import type { LeadReassignment } from './leave';

export interface LeaveEventsInput {
  orgId: string;
  userId: string;
  /** Who acted: the person leaving, the Admin who removed them, or nobody (account deletion). */
  actorId?: string;
  eventType: 'org.member.left' | 'org.member.removed';
  reason?: string;
  reassigned: readonly LeadReassignment[];
}

/**
 * A person left the org (by choice, by removal, or with their account): the membership event, then one
 * lead change per org drive they led, which passed to the org Owner (O-7).
 */
export function leaveAuditEvents(input: LeaveEventsInput): OrgAuditEvent[] {
  const membership: OrgAuditEvent = {
    orgId: input.orgId,
    eventType: input.eventType,
    actorId: input.actorId,
    resourceType: 'user',
    resourceId: input.userId,
    details: { ...(input.reason ? { reason: input.reason } : {}), drivesReassigned: input.reassigned.length },
  };
  const leads: OrgAuditEvent[] = input.reassigned
    .filter((r) => r.orgId === input.orgId)
    .map((r) => ({
      orgId: r.orgId,
      driveId: r.driveId,
      eventType: 'org.drive.lead_changed',
      actorId: input.actorId,
      resourceType: 'drive',
      resourceId: r.driveId,
      details: { fromUserId: r.fromUserId, toUserId: r.toUserId, reason: input.eventType === 'org.member.removed' ? 'removed' : (input.reason ?? 'left_org') },
    }));
  return [membership, ...leads];
}

export function stageLeaveEvents(executor: OrgAuditExecutor, input: LeaveEventsInput): Promise<StagedOrgAuditEvent[]> {
  return stageOrgAuditEvents(executor, leaveAuditEvents(input));
}
