/** Org role ranks, pure (no IO): the one place the ordering MEMBER < ADMIN < OWNER is written. */
import type { OrgRole } from '@pagespace/db/schema/organizations';

export const ORG_ROLE_RANK: Readonly<Record<OrgRole, number>> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

/**
 * Whether `role` ranks at or above `min`. Missing or unknown roles fail closed. The UI renders org
 * controls from this (UI-11: a plain Member sees no org settings); the routes still authorize each
 * request through requireOrgRole.
 */
export function orgRoleAtLeast(role: OrgRole | null | undefined, min: OrgRole): boolean {
  if (!role || !(role in ORG_ROLE_RANK)) return false;
  return ORG_ROLE_RANK[role] >= ORG_ROLE_RANK[min];
}
