/**
 * The ONE org authorization function (Spec ORG-5). Every org mutation and read —
 * web routes now, CLI and MCP in Wave G — asks requireOrgRole(userId, orgId,
 * minRole). The decision is pure (decideOrgRole); the membership lookup is the
 * only IO.
 */
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { findMembershipRole } from './repository';
import { ORG_ROLE_RANK } from './org-roles';

export { ORG_ROLE_RANK };

export type OrgAuthorization =
  | { ok: true; role: OrgRole }
  // A non-member gets 404, not 403: whether an org id exists is itself org data.
  | { ok: false; status: 404; reason: 'not_member' }
  | { ok: false; status: 403; reason: 'insufficient_role' };

export const decideOrgRole = ({
  membershipRole,
  minRole,
}: {
  membershipRole: OrgRole | null;
  minRole: OrgRole;
}): OrgAuthorization => {
  if (membershipRole === null) return { ok: false, status: 404, reason: 'not_member' };
  if (ORG_ROLE_RANK[membershipRole] < ORG_ROLE_RANK[minRole]) {
    return { ok: false, status: 403, reason: 'insufficient_role' };
  }
  return { ok: true, role: membershipRole };
};

export interface RequireOrgRoleDeps {
  findMembershipRole: (orgId: string, userId: string) => Promise<OrgRole | null>;
}

export async function requireOrgRole(
  userId: string,
  orgId: string,
  minRole: OrgRole,
  deps: RequireOrgRoleDeps = { findMembershipRole },
): Promise<OrgAuthorization> {
  const membershipRole = await deps.findMembershipRole(orgId, userId);
  return decideOrgRole({ membershipRole, minRole });
}
