/**
 * Org membership: role changes, removal, and ownership transfer (Spec ORG-1,
 * ORG-2). Callers authorize with requireOrgRole first; these decisions add the
 * rules that depend on WHO the target is.
 *
 * The Owner role moves only through transferOwnership, which rewrites
 * organizations.ownerId and both OWNER/ADMIN rows in one transaction, so the two
 * can never disagree. Leaving an org (and its cascades) is leave.ts (B6), not here.
 */
import { db } from '@pagespace/db/db';
import { and, asc, eq, inArray } from '@pagespace/db/operators';
import { organizations, orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import { decideOrgRole } from './authorize';
import { loadOrgPrincipalKind, type OrgPrincipalKind } from './owner-candidate';
import { leaveOrganization } from './leave';
import { revokeForDemotion } from './demotion';
import { getActorInfo } from '../monitoring/activity-logger';

export type MembershipDecision =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; reason: MembershipRefusal };

/**
 * The route authorized the actor before the write; the actor's role is read again
 * under the row lock, so an Admin demoted or removed in between is refused.
 */
const recheckActor = (actorRole: OrgRole | null): MembershipDecision | null => {
  const actor = decideOrgRole({ membershipRole: actorRole, minRole: 'ADMIN' });
  return actor.ok ? null : actor;
};

export type MembershipRefusal =
  | 'target_not_member'
  | 'use_ownership_transfer'
  | 'use_leave'
  | 'already_owner'
  | 'owner_not_human'
  | 'not_owner'
  | 'not_found'
  | 'not_member'
  | 'insufficient_role';

export const decideRoleChange = ({
  actorRole,
  targetRole,
  newRole,
}: {
  actorId: string;
  actorRole: OrgRole | null;
  targetId: string;
  targetRole: OrgRole | null;
  newRole: OrgRole;
}): MembershipDecision => {
  const actorRefusal = recheckActor(actorRole);
  if (actorRefusal) return actorRefusal;
  if (targetRole === null) return { ok: false, status: 404, reason: 'target_not_member' };
  if (newRole === 'OWNER' || targetRole === 'OWNER') {
    return { ok: false, status: 400, reason: 'use_ownership_transfer' };
  }
  return { ok: true };
};

export const decideMemberRemoval = ({
  actorId,
  actorRole,
  targetId,
  targetRole,
}: {
  actorId: string;
  actorRole: OrgRole | null;
  targetId: string;
  targetRole: OrgRole | null;
}): MembershipDecision => {
  const actorRefusal = recheckActor(actorRole);
  if (actorRefusal) return actorRefusal;
  if (targetRole === null) return { ok: false, status: 404, reason: 'target_not_member' };
  if (targetRole === 'OWNER') return { ok: false, status: 400, reason: 'use_ownership_transfer' };
  if (actorId === targetId) return { ok: false, status: 400, reason: 'use_leave' };
  return { ok: true };
};

export const decideOwnershipTransfer = ({
  currentOwnerId,
  actorId,
  targetId,
  targetRole,
  targetKind,
}: {
  currentOwnerId: string;
  actorId: string;
  targetId: string;
  targetRole: OrgRole | null;
  /** ORG-1: an agent never becomes Owner, member or not. */
  targetKind: OrgPrincipalKind | null;
}): MembershipDecision => {
  if (actorId !== currentOwnerId) return { ok: false, status: 403, reason: 'not_owner' };
  if (targetId === currentOwnerId) return { ok: false, status: 400, reason: 'already_owner' };
  if (targetKind === 'agent') return { ok: false, status: 400, reason: 'owner_not_human' };
  if (targetRole === null) return { ok: false, status: 400, reason: 'target_not_member' };
  return { ok: true };
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Locks the actor's and target's membership rows in id order (no deadlock) and returns both roles. */
async function lockActorAndTargetRoles(
  tx: Tx,
  orgId: string,
  actorId: string,
  targetId: string,
): Promise<{ actorRole: OrgRole | null; targetRole: OrgRole | null }> {
  const rows = await tx
    .select({ userId: orgMembers.userId, role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), inArray(orgMembers.userId, [actorId, targetId])))
    .orderBy(asc(orgMembers.userId))
    .for('update');
  const roleOf = (userId: string) => rows.find((row) => row.userId === userId)?.role ?? null;
  return { actorRole: roleOf(actorId), targetRole: roleOf(targetId) };
}

async function lockTargetRole(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<OrgRole | null> {
  const [row] = await tx
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .for('update');
  return row?.role ?? null;
}

/**
 * Change a member's role. A demotion (Admin to Member) revokes, in the same transaction, what only
 * the higher role could have handed out in the org's drives (revokeForDemotion).
 */
export async function changeMemberRole(input: {
  orgId: string;
  actorId: string;
  targetId: string;
  newRole: OrgRole;
}): Promise<MembershipDecision> {
  return db.transaction(async (tx) => {
    const roles = await lockActorAndTargetRoles(tx, input.orgId, input.actorId, input.targetId);
    const decision = decideRoleChange({ ...input, ...roles });
    if (!decision.ok) return decision;
    await tx
      .update(orgMembers)
      .set({ role: input.newRole })
      .where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.userId, input.targetId)));
    if (roles.targetRole !== null && roles.targetRole !== input.newRole) {
      await revokeForDemotion(tx, {
        orgId: input.orgId,
        userId: input.targetId,
        fromRole: roles.targetRole,
        toRole: input.newRole,
      });
    }
    return decision;
  });
}

/**
 * Removes a member: the same cascade as leaving (leave.ts), in this transaction, so everything the
 * membership handed out in the org's drives is revoked (org-sourced drive rows, agent memberships,
 * share links, MCP key drive rows, OAuth grants naming the drives, former-lead OWNER rows).
 */
export async function removeMember(input: {
  orgId: string;
  actorId: string;
  targetId: string;
}): Promise<MembershipDecision> {
  return db.transaction(async (tx) => {
    const roles = await lockActorAndTargetRoles(tx, input.orgId, input.actorId, input.targetId);
    const decision = decideMemberRemoval({ ...input, ...roles });
    if (!decision.ok) return decision;
    // Removal is a leave the member did not choose: the same cascade runs in this transaction,
    // so org drives the member leads pass to the org Owner (D-OW-7) and what their membership
    // handed out is revoked (D-OW-8). The audit actor is the Admin who removed them.
    const left = await leaveOrganization(input.targetId, input.orgId, tx, {
      actor: await getActorInfo(input.actorId),
    });
    if (!left.ok) return { ok: false, status: 404, reason: 'target_not_member' };
    return decision;
  });
}

/**
 * ORG-1 ownership transfer. The org row is locked first so two concurrent
 * transfers serialize; the old Owner stays in the org as an Admin. The old OWNER
 * row is demoted BEFORE the new one is promoted, because org_members allows at
 * most one OWNER row per org.
 */
export async function transferOwnership(input: {
  orgId: string;
  actorId: string;
  targetId: string;
}): Promise<MembershipDecision> {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ ownerId: organizations.ownerId })
      .from(organizations)
      .where(eq(organizations.id, input.orgId))
      .for('update');
    if (!org) return { ok: false, status: 404, reason: 'not_found' } as const;

    const targetRole = await lockTargetRole(tx, input.orgId, input.targetId);
    const targetKind = await loadOrgPrincipalKind(tx, input.targetId);
    const decision = decideOwnershipTransfer({ currentOwnerId: org.ownerId, ...input, targetRole, targetKind });
    if (!decision.ok) return decision;

    await tx
      .update(orgMembers)
      .set({ role: 'ADMIN' })
      .where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.userId, org.ownerId)));
    await tx
      .update(orgMembers)
      .set({ role: 'OWNER' })
      .where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.userId, input.targetId)));
    await tx.update(organizations).set({ ownerId: input.targetId }).where(eq(organizations.id, input.orgId));
    return decision;
  });
}
