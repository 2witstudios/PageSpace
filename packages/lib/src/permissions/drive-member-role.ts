import type { DriveMemberSource, memberRole } from '@pagespace/db/schema/members';
import type { DriveMemberRole, OrgDriveMembership } from './org-access';

/**
 * What a stored drive_members role means for drive membership: the ONE place a role read from the
 * database becomes a DriveMemberRole. Every loader goes through driveMembershipRole, never a cast.
 *
 * - OWNER, ADMIN and MEMBER are memberships.
 * - GUEST (D-OW-24, the row a redeemed page share link creates) is NOT: a guest holds its page
 *   grants and nothing drive-wide, so for every membership decision (join requests, admission, the
 *   directory, recipients, resolvers) a GUEST row reads as no membership (null).
 *
 * GUEST is classified before the enum value exists on this branch, so the decision is already
 * right when master's migration brings it in. Two guards keep the next value from passing silently:
 * - compile time: MEMBERSHIP_OF must name every value of the database enum, so adding one to
 *   memberRole without classifying it here is a type error;
 * - run time: a string nobody classified throws instead of reading as a membership.
 */

type StoredDriveMemberRole = (typeof memberRole.enumValues)[number];

const MEMBERSHIP_OF: Readonly<Record<StoredDriveMemberRole | 'GUEST', DriveMemberRole | null>> = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',
  GUEST: null,
};

/** The stored roles that are a drive membership; every other stored role is not. */
export const DRIVE_MEMBERSHIP_ROLES: readonly DriveMemberRole[] = Object.values(MEMBERSHIP_OF)
  .filter((role): role is DriveMemberRole => role !== null);

const isClassified = (role: string): role is keyof typeof MEMBERSHIP_OF =>
  Object.prototype.hasOwnProperty.call(MEMBERSHIP_OF, role);

/** The membership a stored role grants, or null when the row is not a drive membership (GUEST). */
export function driveMembershipRole(role: string): DriveMemberRole | null {
  if (!isClassified(role)) {
    throw new Error(`Unknown drive member role "${role}": classify it in permissions/drive-member-role.ts`);
  }
  return MEMBERSHIP_OF[role];
}

/**
 * A stored drive_members row as the membership it carries: null when there is no row, or when the
 * row is no membership (a GUEST row). The shape every resolver takes (OrgDriveMembership).
 */
export function driveMembershipRow(
  row: { role: string; customRoleId: string | null; source: DriveMemberSource } | null | undefined,
): OrgDriveMembership | null {
  if (!row) return null;
  const role = driveMembershipRole(row.role);
  return role === null ? null : { role, customRoleId: row.customRoleId, source: row.source };
}
