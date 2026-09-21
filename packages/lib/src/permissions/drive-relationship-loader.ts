import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import { securityAudit, type AuditEvent } from '../audit/security-audit';
import { loggers } from '../logging/logger-config';
import {
  loadAcceptedRowsInDrives,
  loadEffectiveDriveMembership,
  resolveEffectiveDriveMemberships,
  type ResolveMembershipsOptions,
} from './org-drive-membership';
import {
  decideDriveLeadAuthority,
  isDriveLead,
  type DriveLeadAuthority,
  type DriveRelationship,
  type RelationshipDrive,
} from './drive-relationship';

/** The IO around the drive relationship decisions in drive-relationship.ts. */

export const LEAD_RELATIONSHIP: DriveRelationship = { isOwner: true, membership: null };

export async function loadDriveRelationship(userId: string, drive: RelationshipDrive): Promise<DriveRelationship> {
  if (isDriveLead(userId, drive)) return LEAD_RELATIONSHIP;
  return { isOwner: false, membership: await loadEffectiveDriveMembership(userId, drive) };
}

/**
 * loadDriveRelationship for many drives at once, keyed by drive id: one accepted-rows query plus the
 * shared resolver's (at most two) org queries, however many drives.
 */
export async function loadDriveRelationships(
  userId: string,
  driveList: RelationshipDrive[],
  options: ResolveMembershipsOptions = { audit: true },
): Promise<Map<string, DriveRelationship>> {
  const out = new Map<string, DriveRelationship>();
  const notLed = driveList.filter((drive) => !isDriveLead(userId, drive));
  for (const drive of driveList) if (isDriveLead(userId, drive)) out.set(drive.id, LEAD_RELATIONSHIP);
  if (notLed.length === 0) return out;

  const rows = await loadAcceptedRowsInDrives(db, userId, notLed.map((drive) => drive.id));
  const effective = await resolveEffectiveDriveMemberships(
    notLed.map((drive) => ({ userId, drive, row: rows.get(drive.id) ?? null })),
    options,
  );
  notLed.forEach((drive, i) => out.set(drive.id, { isOwner: false, membership: effective[i] }));
  return out;
}

/** The lead actions org power may take on an org-owned drive, as named in the audit event. */
export type DriveLeadAction = 'rename' | 'trash' | 'restore' | 'permanent_delete';

async function orgRoleIn(orgId: string, userId: string) {
  const [membership] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  return membership?.role ?? null;
}

/**
 * One `authz.access.granted` event for a lead action org Owner/Admin power took (every visibility;
 * the details carry the action, the org power and the drive's visibility). Awaited; a failed append
 * is logged and does not undo the action.
 */
async function writeOrgPowerDriveAction(
  userId: string,
  drive: RelationshipDrive,
  action: DriveLeadAction,
  authority: { via: 'org-owner' | 'org-admin'; orgId: string },
): Promise<void> {
  const event: AuditEvent = {
    eventType: 'authz.access.granted',
    userId,
    resourceType: 'drive',
    resourceId: drive.id,
    details: { via: authority.via === 'org-owner' ? 'org_owner' : 'org_admin', action, orgId: authority.orgId, orgVisibility: drive.orgVisibility },
  };
  loggers.security.info(`[Audit] ${event.eventType}`, { ...event });
  try {
    await securityAudit.logEvent(event);
  } catch (error) {
    loggers.security.error('[Audit] org lead-action audit write failed', {
      userId,
      driveId: drive.id,
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * decideDriveLeadAuthority with its IO: the user's role in the drive's org (read only while
 * ORGS_ENABLED, only for an org drive the user does not lead), and the audit event when org
 * Owner/Admin power is what allows the action.
 */
export async function loadDriveLeadAuthority(
  userId: string,
  drive: RelationshipDrive,
  action: DriveLeadAction,
): Promise<DriveLeadAuthority> {
  if (isDriveLead(userId, drive)) return { allowed: true, via: 'lead' };
  if (!ORGS_ENABLED || drive.orgId === null) return { allowed: false };

  const authority = decideDriveLeadAuthority({ orgsEnabled: true, userId, drive, orgRole: await orgRoleIn(drive.orgId, userId) });
  if (authority.allowed && authority.via !== 'lead') await writeOrgPowerDriveAction(userId, drive, action, authority);
  return authority;
}

/**
 * For an action a drive owner-or-admin gate already allowed (rename and trash through the drive
 * settings route): write the same audit event when the actor holds org Owner/Admin power over the
 * drive and does not lead it. Writes nothing for the lead, a personal drive, or while dark.
 */
export async function recordOrgPowerDriveAction(
  userId: string,
  drive: RelationshipDrive,
  action: DriveLeadAction,
): Promise<void> {
  await loadDriveLeadAuthority(userId, drive, action);
}
