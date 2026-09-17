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
import { and, eq } from '@pagespace/db/operators';
import { organizations, orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';

export type MembershipDecision =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; reason: MembershipRefusal };

export type MembershipRefusal =
  | 'target_not_member'
  | 'use_ownership_transfer'
  | 'use_leave'
  | 'already_owner'
  | 'not_owner'
  | 'not_found';

export const decideRoleChange = ({
  targetRole,
  newRole,
}: {
  actorId: string;
  targetId: string;
  targetRole: OrgRole | null;
  newRole: OrgRole;
}): MembershipDecision => {
  if (targetRole === null) return { ok: false, status: 404, reason: 'target_not_member' };
  if (newRole === 'OWNER' || targetRole === 'OWNER') {
    return { ok: false, status: 400, reason: 'use_ownership_transfer' };
  }
  return { ok: true };
};

export const decideMemberRemoval = ({
  actorId,
  targetId,
  targetRole,
}: {
  actorId: string;
  targetId: string;
  targetRole: OrgRole | null;
}): MembershipDecision => {
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
}: {
  currentOwnerId: string;
  actorId: string;
  targetId: string;
  targetRole: OrgRole | null;
}): MembershipDecision => {
  if (actorId !== currentOwnerId) return { ok: false, status: 403, reason: 'not_owner' };
  if (targetId === currentOwnerId) return { ok: false, status: 400, reason: 'already_owner' };
  if (targetRole === null) return { ok: false, status: 400, reason: 'target_not_member' };
  return { ok: true };
};

async function lockTargetRole(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
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

export async function changeMemberRole(input: {
  orgId: string;
  actorId: string;
  targetId: string;
  newRole: OrgRole;
}): Promise<MembershipDecision> {
  return db.transaction(async (tx) => {
    const targetRole = await lockTargetRole(tx, input.orgId, input.targetId);
    const decision = decideRoleChange({ ...input, targetRole });
    if (!decision.ok) return decision;
    await tx
      .update(orgMembers)
      .set({ role: input.newRole })
      .where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.userId, input.targetId)));
    return decision;
  });
}

/**
 * Removes the membership row only. The O-8 cascades (agent memberships, share
 * links, MCP token drive rows, org-sourced drive rows) belong to leave.ts (B6).
 */
export async function removeMember(input: {
  orgId: string;
  actorId: string;
  targetId: string;
}): Promise<MembershipDecision> {
  return db.transaction(async (tx) => {
    const targetRole = await lockTargetRole(tx, input.orgId, input.targetId);
    const decision = decideMemberRemoval({ ...input, targetRole });
    if (!decision.ok) return decision;
    await tx
      .delete(orgMembers)
      .where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.userId, input.targetId)));
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
    const decision = decideOwnershipTransfer({ currentOwnerId: org.ownerId, ...input, targetRole });
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
