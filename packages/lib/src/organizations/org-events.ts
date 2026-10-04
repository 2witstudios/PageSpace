/**
 * Org audit events that several mutations share (Spec AUD-1). Each is written after its change has
 * committed, through recordOrgAuditEventAfterCommit: a refused append is logged, never turned into a
 * failure of a change that has already happened.
 */
import { recordOrgAuditEventAfterCommit } from '../audit/org-audit';
import type { LeadReassignment } from './leave';

/**
 * A person left the org (by choice, by removal, or with their account): the membership event, then one
 * lead change per org drive they led, which passed to the org Owner (O-7).
 */
export async function recordLeaveEvents(input: {
  orgId: string;
  userId: string;
  /** Who acted: the person leaving, the Admin who removed them, or nobody (account deletion). */
  actorId?: string;
  eventType: 'org.member.left' | 'org.member.removed';
  reason?: string;
  reassigned: readonly LeadReassignment[];
}): Promise<void> {
  await recordOrgAuditEventAfterCommit({
    orgId: input.orgId,
    eventType: input.eventType,
    actorId: input.actorId,
    resourceType: 'user',
    resourceId: input.userId,
    details: { ...(input.reason ? { reason: input.reason } : {}), drivesReassigned: input.reassigned.length },
  });
  for (const r of input.reassigned) {
    if (r.orgId !== input.orgId) continue;
    await recordOrgAuditEventAfterCommit({
      orgId: r.orgId,
      driveId: r.driveId,
      eventType: 'org.drive.lead_changed',
      actorId: input.actorId,
      resourceType: 'drive',
      resourceId: r.driveId,
      details: { fromUserId: r.fromUserId, toUserId: r.toUserId, reason: input.eventType === 'org.member.removed' ? 'removed' : (input.reason ?? 'left_org') },
    });
  }
}
