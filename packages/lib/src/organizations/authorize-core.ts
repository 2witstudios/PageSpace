/**
 * The pure half of the ONE org authorization function (Spec ORG-5). Every org authority
 * decision — a route's gate (requireOrgRole in authorize.ts), a service's in-transaction
 * re-check, a pure policy decision — asks decideOrgRole, or holdsOrgRole where only the
 * yes/no matters. No IO, so pure decision modules import this file, never authorize.ts.
 */
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { orgRoleAtLeast } from './org-roles';

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
  // orgRoleAtLeast fails closed on an unknown role (a bare rank comparison would admit it).
  if (!orgRoleAtLeast(membershipRole, minRole)) return { ok: false, status: 403, reason: 'insufficient_role' };
  return { ok: true, role: membershipRole };
};

/** Whether a person with this org role (null/undefined: not a member) holds at least `minRole`. */
export const holdsOrgRole = (membershipRole: OrgRole | null | undefined, minRole: OrgRole): boolean =>
  decideOrgRole({ membershipRole: membershipRole ?? null, minRole }).ok;
