/**
 * Drive Agent Service - membership of AI agents (AI_CHAT pages) in drives.
 *
 * An agent can be a member of drives other than its home drive. Membership is
 * the sole mechanism that grants an agent's tools access to a drive's content
 * (see `hasAgentDriveMembership` / `getAgentAccessLevel`). This service is the
 * single seam for creating/removing those memberships, with authorization and
 * role-capping applied consistently for both entry points (the agent's own
 * settings, and the drive-side "invite agent" flow).
 */

import { db } from '@pagespace/db/db';
import { eq, and, ne, isNotNull, inArray } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveMembers } from '@pagespace/db/schema/members';
import { canUserEditPage, getUserDriveAccess, isDriveOwnerOrAdmin } from '../permissions/permissions';
import { customRoleBelongsToDrive, fetchCustomRolePermissions } from '../permissions/membership-queries';
import type { CustomRolePerms } from '../permissions/membership-queries';
import { isHomeDrive, homeDriveActionError } from './drive-guards';

export type AgentDriveRole = 'MEMBER' | 'ADMIN';

export interface AddAgentToDriveInput {
  actingUserId: string;
  agentPageId: string;
  driveId: string;
  /** Explicit role request (drive-side invite). Omitted ⇒ inherit the granter's access. */
  requestedRole?: AgentDriveRole;
  /** Optional custom drive role to assign (owners/admins only). */
  requestedCustomRoleId?: string | null;
}

export type ServiceFailure = { ok: false; status: number; error: string };

export type AddAgentToDriveResult =
  | { ok: true; status: 201; member: typeof driveAgentMembers.$inferSelect }
  | ServiceFailure;

export interface AgentDriveMembership {
  driveId: string;
  driveName: string;
  driveSlug: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  customRoleId: string | null;
  isHome: boolean;
}

/**
 * Resolve the acting user's access to a drive, used to cap what they may grant
 * an agent. Owners/admins may grant up to ADMIN (or a custom role); plain
 * members and page-level collaborators are capped at MEMBER.
 */
async function resolveGranterAccess(
  userId: string,
  driveId: string,
): Promise<{ canGrant: boolean; maxRole: AgentDriveRole; customRoleId: string | null; driveKind: string | null }> {
  const [drive] = await db
    .select({ ownerId: drives.ownerId, kind: drives.kind })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  if (!drive) return { canGrant: false, maxRole: 'MEMBER', customRoleId: null, driveKind: null };
  const driveKind = drive.kind ?? null;
  if (drive.ownerId === userId) return { canGrant: true, maxRole: 'ADMIN', customRoleId: null, driveKind };

  const [membership] = await db
    .select({ role: driveMembers.role, customRoleId: driveMembers.customRoleId })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ))
    .limit(1);

  if (membership) {
    return {
      canGrant: true,
      maxRole: membership.role === 'ADMIN' ? 'ADMIN' : 'MEMBER',
      customRoleId: membership.customRoleId ?? null,
      driveKind,
    };
  }

  // Page-level collaborator only (no drive membership): may grant, capped at MEMBER.
  const hasAccess = await getUserDriveAccess(userId, driveId);
  return { canGrant: hasAccess, maxRole: 'MEMBER', customRoleId: null, driveKind };
}

/**
 * Add an agent (AI_CHAT page) as a member of a drive. The agent's home drive
 * may differ from the target drive. The granted role never exceeds the acting
 * user's own access to the drive.
 */
export async function addAgentToDrive(input: AddAgentToDriveInput): Promise<AddAgentToDriveResult> {
  const { actingUserId, agentPageId, driveId, requestedRole, requestedCustomRoleId } = input;

  const [agentPage] = await db
    .select({ id: pages.id, type: pages.type })
    .from(pages)
    .where(eq(pages.id, agentPageId))
    .limit(1);

  if (!agentPage) return { ok: false, status: 404, error: 'Agent page not found' };
  if (agentPage.type !== 'AI_CHAT') {
    return { ok: false, status: 400, error: 'agentPageId must reference an AI_CHAT page' };
  }

  // The acting user must *control* the agent (edit access), not merely view it.
  // Membership is a property of the agent shared by everyone who can run it
  // (running is gated by `canUserEditPage` in the chat route), so attaching the
  // agent to a drive must require the same control. A view-only granter could
  // otherwise bind a shared agent to a private drive and leak that drive's
  // content to every user who can run the agent.
  if (!(await canUserEditPage(actingUserId, agentPageId))) {
    return { ok: false, status: 403, error: 'You do not have permission to manage this agent' };
  }

  const granter = await resolveGranterAccess(actingUserId, driveId);
  if (!granter.canGrant) {
    return { ok: false, status: 403, error: 'You do not have access to this drive' };
  }

  // Home drives never take agent memberships: an agent living in another
  // (possibly shared) drive would let everyone who can run it read Home
  // content. AI_CHAT pages inside Home keep their native access — this only
  // blocks cross-drive membership grants. Enforced here so both entry points
  // (drive-side invite and agent-side settings) share the guard.
  if (isHomeDrive({ kind: granter.driveKind })) {
    return { ok: false, status: 403, error: homeDriveActionError({ kind: granter.driveKind }, 'invite')! };
  }

  let effectiveRole: AgentDriveRole;
  let effectiveCustomRoleId: string | null = null;

  if (requestedCustomRoleId) {
    if (granter.maxRole !== 'ADMIN') {
      return { ok: false, status: 403, error: 'Only drive owners and admins can assign custom roles' };
    }
    if (!(await customRoleBelongsToDrive(requestedCustomRoleId, driveId))) {
      return { ok: false, status: 404, error: 'Custom role not found in this drive' };
    }
    effectiveRole = 'MEMBER';
    effectiveCustomRoleId = requestedCustomRoleId;
  } else if (requestedRole) {
    if (requestedRole === 'ADMIN' && granter.maxRole !== 'ADMIN') {
      return { ok: false, status: 403, error: 'You cannot grant a role higher than your own access' };
    }
    effectiveRole = requestedRole;
  } else {
    // Inherit the granter's access (agent-side add).
    effectiveRole = granter.maxRole;
    effectiveCustomRoleId = granter.customRoleId;
  }

  try {
    const [member] = await db
      .insert(driveAgentMembers)
      .values({
        driveId,
        agentPageId,
        role: effectiveRole,
        customRoleId: effectiveCustomRoleId,
        addedBy: actingUserId,
      })
      .returning();
    return { ok: true, status: 201, member };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return { ok: false, status: 409, error: 'Agent is already a member of this drive' };
    }
    throw err;
  }
}

/**
 * Remove an agent's membership from a drive. The agent's home drive cannot be
 * removed. Allowed for users who control the agent or who own/admin the drive.
 */
export async function removeAgentFromDrive(input: {
  actingUserId: string;
  agentPageId: string;
  driveId: string;
}): Promise<{ ok: true } | ServiceFailure> {
  const { actingUserId, agentPageId, driveId } = input;

  const [agentPage] = await db
    .select({ id: pages.id, driveId: pages.driveId })
    .from(pages)
    .where(eq(pages.id, agentPageId))
    .limit(1);

  if (!agentPage) return { ok: false, status: 404, error: 'Agent page not found' };
  if (agentPage.driveId === driveId) {
    return { ok: false, status: 400, error: 'Cannot remove an agent from its home drive' };
  }

  const canManage =
    (await canUserEditPage(actingUserId, agentPageId)) ||
    (await isDriveOwnerOrAdmin(actingUserId, driveId));
  if (!canManage) {
    return { ok: false, status: 403, error: 'You cannot manage this agent membership' };
  }

  const deleted = await db
    .delete(driveAgentMembers)
    .where(and(eq(driveAgentMembers.agentPageId, agentPageId), eq(driveAgentMembers.driveId, driveId)))
    .returning({ id: driveAgentMembers.id });

  if (deleted.length === 0) return { ok: false, status: 404, error: 'Membership not found' };
  return { ok: true };
}

/** A Drizzle transaction handle, accepted alongside the module-level `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Revoke every non-home agent membership in `driveId` that was granted by
 * `userId`. Called when that user is removed from the drive: the grant's
 * authorization basis (`addedBy`) is gone, so the agent loses the access it
 * inherited too. The agent's home drive is never touched (it can't be removed,
 * and a home-drive membership has `pages.driveId === driveAgentMembers.driveId`).
 *
 * Accepts a transaction so it can run atomically with the member removal.
 * Returns the agentPageIds whose membership was revoked (for audit logging).
 */
export async function revokeAgentMembershipsGrantedBy(
  executor: Tx | typeof db,
  driveId: string,
  userId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ id: driveAgentMembers.id, agentPageId: driveAgentMembers.agentPageId })
    .from(driveAgentMembers)
    .innerJoin(pages, eq(driveAgentMembers.agentPageId, pages.id))
    .where(and(
      eq(driveAgentMembers.driveId, driveId),
      eq(driveAgentMembers.addedBy, userId),
      ne(pages.driveId, driveId),
    ));

  if (rows.length === 0) return [];

  await executor
    .delete(driveAgentMembers)
    .where(inArray(driveAgentMembers.id, rows.map((r) => r.id)));

  return rows.map((r) => r.agentPageId);
}

/**
 * True when every grant in `sub` is matched (≥) by `sup` — i.e. role `sub` can
 * see/do nothing role `sup` cannot. Pages `sub` grants nothing on impose no
 * constraint.
 */
function customRoleSubset(sub: CustomRolePerms, sup: CustomRolePerms): boolean {
  for (const [pageId, p] of Object.entries(sub)) {
    if (!p.canView && !p.canEdit && !p.canShare) continue;
    const s = sup[pageId];
    if (!s) return false;
    if ((p.canView && !s.canView) || (p.canEdit && !s.canEdit) || (p.canShare && !s.canShare)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether an agent's MEMBER-level grant (`agentCustomRoleId`) is still within the
 * granter's current cap (`capCustomRoleId`), both at MEMBER rank. Lets recap skip
 * an agent on a lateral/widening custom-role change (the agent's old role is a
 * subset of the granter's new role) instead of needlessly revoking it.
 *
 * Only the custom-role-vs-custom-role case is compared precisely (a cheap matrix
 * subset). Cases involving plain MEMBER (null) on either side are conservatively
 * treated as NOT within: plain MEMBER spans every non-private page in the drive —
 * a scope not expressed as a per-page matrix — so we fail closed (revoke) rather
 * than enumerate the drive's pages on a security path.
 */
async function memberGrantWithinCap(
  agentCustomRoleId: string | null,
  capCustomRoleId: string | null,
  driveId: string,
): Promise<boolean> {
  // Only "both plain MEMBER" is provably within without comparing matrices.
  if (agentCustomRoleId === null || capCustomRoleId === null) {
    return agentCustomRoleId === capCustomRoleId;
  }
  const [agentPerms, capPerms] = await Promise.all([
    fetchCustomRolePermissions(agentCustomRoleId, driveId),
    fetchCustomRolePermissions(capCustomRoleId, driveId),
  ]);
  // An unresolvable custom role resolves as plain MEMBER (drive-wide), which is
  // not a provable subset of a scoped cap ⇒ fail closed.
  if (!agentPerms || !capPerms) return false;
  // A role with driveWidePermissions spans all non-private pages — not expressible
  // as a per-page matrix — so fail closed (same rationale as plain MEMBER above).
  if (agentPerms.driveWidePermissions || capPerms.driveWidePermissions) return false;
  return customRoleSubset(agentPerms.permissions, capPerms.permissions);
}

/**
 * Re-cap the agent memberships in `driveId` granted by `userId` when the user's
 * access is downgraded, bringing every agent they granted down to exactly what
 * they could grant today. Only ever caps DOWN — never widens an agent's reach,
 * never leaves it with more than the downgraded granter.
 *
 * Agent access is bottlenecked by the granting user's access: a plain MEMBER
 * agent membership now resolves to the same view a plain MEMBER *user* gets
 * (non-private pages only — see `agent-permissions.ts`). For each non-home
 * membership the user granted, with the granter now capped at MEMBER:
 *  - role ADMIN ⇒ REDUCE to `{ role: 'MEMBER', customRoleId: <granter's cap> }`.
 *    ADMIN is full access ⊋ any MEMBER cap, so this strictly narrows.
 *  - role MEMBER, customRoleId === the granter's ⇒ leave (already exactly what
 *    the granter could grant today).
 *  - role MEMBER, customRoleId differs ⇒ keep ONLY if the agent's grant is
 *    provably ⊆ the granter's new grant (`memberGrantWithinCap`) — e.g. the
 *    granter moved to a *broader* custom role, so the agent still sits under
 *    them. Otherwise REVOKE. We never rewrite a member row to a different role
 *    (that could widen — a custom-role matrix is incomparable to the cap), and
 *    we never revoke an agent that's still within the granter (no false revoke
 *    on a lateral/widening change).
 *
 * No-op when the user can still grant ADMIN. Excludes the agent's home drive.
 * Returns the affected agentPageIds (both reduced and revoked).
 */
export async function recapAgentMembershipsGrantedBy(
  driveId: string,
  userId: string,
): Promise<string[]> {
  const granter = await resolveGranterAccess(userId, driveId);
  // Still able to grant ADMIN ⇒ nothing to cap down (we only ever cap downward).
  if (granter.maxRole === 'ADMIN') return [];

  const capCustomRoleId = granter.customRoleId ?? null;

  const rows = await db
    .select({
      id: driveAgentMembers.id,
      agentPageId: driveAgentMembers.agentPageId,
      role: driveAgentMembers.role,
      customRoleId: driveAgentMembers.customRoleId,
    })
    .from(driveAgentMembers)
    .innerJoin(pages, eq(driveAgentMembers.agentPageId, pages.id))
    .where(and(
      eq(driveAgentMembers.driveId, driveId),
      eq(driveAgentMembers.addedBy, userId),
      ne(pages.driveId, driveId),
    ));

  // ADMIN agents always exceed a MEMBER cap ⇒ reduce them to the cap.
  const toReduce = rows.filter((r) => r.role === 'ADMIN');
  // MEMBER agents whose custom role differs from the cap: keep iff provably within.
  const memberMismatch = rows.filter(
    (r) => r.role !== 'ADMIN' && (r.customRoleId ?? null) !== capCustomRoleId,
  );
  const withinCap = await Promise.all(
    memberMismatch.map((r) =>
      memberGrantWithinCap(r.customRoleId ?? null, capCustomRoleId, driveId),
    ),
  );
  const toRevoke = memberMismatch.filter((_, i) => !withinCap[i]);

  if (toReduce.length > 0) {
    await db
      .update(driveAgentMembers)
      .set({ role: 'MEMBER', customRoleId: capCustomRoleId })
      .where(inArray(driveAgentMembers.id, toReduce.map((r) => r.id)));
  }
  if (toRevoke.length > 0) {
    await db
      .delete(driveAgentMembers)
      .where(inArray(driveAgentMembers.id, toRevoke.map((r) => r.id)));
  }

  return [...toReduce, ...toRevoke].map((r) => r.agentPageId);
}

/**
 * List the drives an agent can access: its membership rows plus its home drive
 * (the home drive is always included, even if a legacy agent lacks a membership
 * row for it).
 */
export async function listAgentDrives(agentPageId: string): Promise<AgentDriveMembership[]> {
  const [agentPage] = await db
    .select({ driveId: pages.driveId })
    .from(pages)
    .where(eq(pages.id, agentPageId))
    .limit(1);

  if (!agentPage) return [];

  const rows = await db
    .select({
      driveId: driveAgentMembers.driveId,
      role: driveAgentMembers.role,
      customRoleId: driveAgentMembers.customRoleId,
      driveName: drives.name,
      driveSlug: drives.slug,
    })
    .from(driveAgentMembers)
    .innerJoin(drives, eq(driveAgentMembers.driveId, drives.id))
    .where(eq(driveAgentMembers.agentPageId, agentPageId));

  const result: AgentDriveMembership[] = rows.map((r) => ({
    driveId: r.driveId,
    driveName: r.driveName,
    driveSlug: r.driveSlug,
    role: r.role,
    customRoleId: r.customRoleId ?? null,
    isHome: r.driveId === agentPage.driveId,
  }));

  if (!result.some((r) => r.isHome)) {
    const [home] = await db
      .select({ id: drives.id, name: drives.name, slug: drives.slug })
      .from(drives)
      .where(eq(drives.id, agentPage.driveId))
      .limit(1);
    if (home) {
      result.unshift({
        driveId: home.id,
        driveName: home.name,
        driveSlug: home.slug,
        role: 'ADMIN',
        customRoleId: null,
        isHome: true,
      });
    }
  }

  return result;
}
