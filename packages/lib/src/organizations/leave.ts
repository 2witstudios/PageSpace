/**
 * Leaving an organization, and the cascade account deletion runs through (Spec O-7, O-8, ORG-6).
 *
 * A person who leaves an org takes with them everything their org membership let them hand out
 * inside org drives: the org-sourced drive_members rows, agent memberships they granted, share
 * links they created, and the drive rows of their own MCP tokens. Drives they lead are not
 * theirs to take: each is reassigned to the org Owner with an audit event, because
 * drives.ownerId is ON DELETE CASCADE and a lead's account deletion would otherwise hard-delete
 * the org drive.
 *
 * Nothing outside the org's drives is touched: a person's rows in personal drives, or in other
 * orgs' drives, survive leaving this one.
 *
 * Account deletion calls leaveAllOrganizations inside its own transaction BEFORE the users row
 * is deleted (account-repository.deleteUser).
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, mcpTokenDrives } from '@pagespace/db/schema/members';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import { orgMembers, organizations, type OrgRole } from '@pagespace/db/schema/organizations';
import { revokeAgentMembershipsGrantedBy } from '../services/drive-agent-service';
import { getActorInfo, logActivityWithTx } from '../monitoring/activity-logger';

/** A Drizzle transaction handle. */
export type LeaveTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── Pure decisions ────────────────────────────────────────────────────────────

export type LeaveRefusal = 'NOT_A_MEMBER' | 'OWNER_MUST_TRANSFER';

export type LeaveDecision = { ok: true } | { ok: false; reason: LeaveRefusal };

/**
 * Whether a membership may leave. The Owner cannot: an org always has one human Owner (ORG-1),
 * and the Owner is where every departing lead's drives land (O-7). Ownership transfers first.
 */
export function decideLeave(membership: { role: OrgRole } | null): LeaveDecision {
  if (!membership) return { ok: false, reason: 'NOT_A_MEMBER' };
  if (membership.role === 'OWNER') return { ok: false, reason: 'OWNER_MUST_TRANSFER' };
  return { ok: true };
}

export interface LedOrgDrive {
  driveId: string;
  orgId: string;
  orgOwnerId: string;
}

export interface LeadReassignment {
  driveId: string;
  orgId: string;
  fromUserId: string;
  toUserId: string;
}

/** Each org drive the departing user leads goes to its org's Owner (O-7). */
export function planLeadReassignments(userId: string, ledDrives: LedOrgDrive[]): LeadReassignment[] {
  return ledDrives
    .filter((d) => d.orgOwnerId !== userId)
    .map((d) => ({ driveId: d.driveId, orgId: d.orgId, fromUserId: userId, toUserId: d.orgOwnerId }));
}

// ── IO ────────────────────────────────────────────────────────────────────────

export type LeadReassignmentReason = 'left_org' | 'account_deleted';

export interface LeaveActor {
  actorEmail: string;
  actorDisplayName?: string;
}

export interface ReassignLedOrgDrivesOptions {
  /** Limit to one org's drives (leaving one org). Omitted: every org drive the user leads. */
  orgId?: string;
  reason?: LeadReassignmentReason;
  /** Actor snapshot for the audit event; resolved from the user when omitted. */
  actor?: LeaveActor;
}

/**
 * Reassign every org drive `userId` leads (trashed ones included) to that org's Owner, writing
 * an `ownership_transfer` activity event per drive in the same transaction. Rows are locked
 * FOR UPDATE, drive and org together, so a concurrent ownership transfer cannot leave a drive
 * with the previous Owner as its lead.
 */
export async function reassignLedOrgDrives(
  userId: string,
  tx: LeaveTx,
  options: ReassignLedOrgDrivesOptions = {},
): Promise<LeadReassignment[]> {
  const led = await tx
    .select({ driveId: drives.id, orgId: organizations.id, orgOwnerId: organizations.ownerId })
    .from(drives)
    .innerJoin(organizations, eq(drives.orgId, organizations.id))
    .where(and(
      eq(drives.ownerId, userId),
      options.orgId ? eq(drives.orgId, options.orgId) : undefined,
    ))
    .for('update');

  const plan = planLeadReassignments(userId, led);
  if (plan.length === 0) return [];

  const actor = options.actor ?? (await getActorInfo(userId));
  const reason = options.reason ?? 'left_org';

  for (const r of plan) {
    await tx.update(drives).set({ ownerId: r.toUserId }).where(eq(drives.id, r.driveId));
    await logActivityWithTx(
      {
        userId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        operation: 'ownership_transfer',
        resourceType: 'drive',
        resourceId: r.driveId,
        driveId: r.driveId,
        previousValues: { ownerId: r.fromUserId },
        newValues: { ownerId: r.toUserId },
        metadata: { orgId: r.orgId, reason },
      },
      tx as unknown as typeof db,
    );
  }

  return plan;
}

export interface LeaveCascadeCounts {
  orgMembershipRows: number;
  agentMemberships: number;
  driveShareLinks: number;
  pageShareLinks: number;
  mcpTokenDriveRows: number;
}

export type LeaveOrganizationResult =
  | { ok: true; revoked: LeaveCascadeCounts; reassigned: LeadReassignment[] }
  | { ok: false; reason: LeaveRefusal };

export interface LeaveOrganizationOptions {
  reason?: LeadReassignmentReason;
  actor?: LeaveActor;
}

/**
 * Remove `userId` from `orgId` and revoke what the membership let them hand out in the org's
 * drives (O-8), reassigning drives they lead (O-7). Runs in `tx` when given, else in its own
 * transaction. Refusals change nothing.
 */
export async function leaveOrganization(
  userId: string,
  orgId: string,
  tx?: LeaveTx,
  options: LeaveOrganizationOptions = {},
): Promise<LeaveOrganizationResult> {
  if (!tx) return db.transaction((own) => leaveOrganization(userId, orgId, own, options));

  const [membership] = await tx
    .select({ id: orgMembers.id, role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .for('update');

  const decision = decideLeave(membership ?? null);
  if (!decision.ok) return decision;

  const orgDriveIds = tx.select({ id: drives.id }).from(drives).where(eq(drives.orgId, orgId));

  const memberRows = await tx
    .delete(driveMembers)
    .where(and(
      eq(driveMembers.userId, userId),
      eq(driveMembers.source, 'org'),
      inArray(driveMembers.driveId, orgDriveIds),
    ))
    .returning({ id: driveMembers.id });

  // revokeAgentMembershipsGrantedBy is per drive and already spares the agent's home drive.
  let agentMemberships = 0;
  const driveRows = await tx.select({ id: drives.id }).from(drives).where(eq(drives.orgId, orgId));
  for (const { id } of driveRows) {
    agentMemberships += (await revokeAgentMembershipsGrantedBy(tx, id, userId)).length;
  }

  const driveLinks = await tx
    .delete(driveShareLinks)
    .where(and(eq(driveShareLinks.createdBy, userId), inArray(driveShareLinks.driveId, orgDriveIds)))
    .returning({ id: driveShareLinks.id });

  const pageLinks = await tx
    .delete(pageShareLinks)
    .where(and(
      eq(pageShareLinks.createdBy, userId),
      inArray(
        pageShareLinks.pageId,
        tx.select({ id: pages.id }).from(pages).where(inArray(pages.driveId, orgDriveIds)),
      ),
    ))
    .returning({ id: pageShareLinks.id });

  const tokenRows = await tx
    .delete(mcpTokenDrives)
    .where(and(
      inArray(mcpTokenDrives.driveId, orgDriveIds),
      inArray(mcpTokenDrives.tokenId, tx.select({ id: mcpTokens.id }).from(mcpTokens).where(eq(mcpTokens.userId, userId))),
    ))
    .returning({ id: mcpTokenDrives.id });

  const reassigned = await reassignLedOrgDrives(userId, tx, {
    orgId,
    reason: options.reason,
    actor: options.actor,
  });

  await tx.delete(orgMembers).where(eq(orgMembers.id, membership.id));

  return {
    ok: true,
    revoked: {
      orgMembershipRows: memberRows.length,
      agentMemberships,
      driveShareLinks: driveLinks.length,
      pageShareLinks: pageLinks.length,
      mcpTokenDriveRows: tokenRows.length,
    },
    reassigned,
  };
}

export class LeaveOrganizationRefusedError extends Error {
  constructor(readonly orgId: string, readonly reason: LeaveRefusal) {
    super(`Cannot leave organization ${orgId}: ${reason}`);
    this.name = 'LeaveOrganizationRefusedError';
  }
}

/**
 * Leave every org `userId` belongs to, inside `tx`. Throws LeaveOrganizationRefusedError on the
 * first refusal (an Owner), so the caller's transaction rolls back: account deletion must not
 * proceed half-cascaded.
 */
export async function leaveAllOrganizations(
  userId: string,
  tx: LeaveTx,
  options: LeaveOrganizationOptions = {},
): Promise<LeadReassignment[]> {
  const memberships = await tx
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId));

  const reassigned: LeadReassignment[] = [];
  for (const { orgId } of memberships) {
    const result = await leaveOrganization(userId, orgId, tx, options);
    if (!result.ok) throw new LeaveOrganizationRefusedError(orgId, result.reason);
    reassigned.push(...result.reassigned);
  }
  return reassigned;
}
