/**
 * The ONE org authorization function (Spec ORG-5). Every org mutation and read —
 * web routes, and through them the CLI and MCP (Spec X-1) — asks requireOrgRole(userId,
 * orgId, minRole). The decision is pure (decideOrgRole, authorize-core.ts); the
 * membership lookup is the only IO.
 */
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { findMembershipRole } from './repository';
import { decideOrgRole, type OrgAuthorization } from './authorize-core';

export { ORG_ROLE_RANK } from './org-roles';
export { decideOrgRole, holdsOrgRole, type OrgAuthorization } from './authorize-core';

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
