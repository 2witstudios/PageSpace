import type { DriveMemberSource, memberRole } from '@pagespace/db/schema/members';
import type { DriveMemberRole, OrgDriveMembership } from './org-access';
import { loggers } from '../logging/logger-config';

/**
 * What a stored drive_members role means for drive membership: the ONE place a role read from the
 * database becomes a DriveMemberRole. Every loader goes through driveMembershipRole, never a cast.
 *
 * - OWNER, ADMIN and MEMBER are memberships.
 * - GUEST (D-OW-24, the row a redeemed page share link creates) is NOT: a guest holds its page
 *   grants and nothing drive-wide, so for every membership decision (join requests, admission, the
 *   directory, recipients, resolvers) a GUEST row reads as no membership (null).
 *
 * Master's 0308 (#2723) added GUEST to the enum; master's own per-site checks use isGuestRole
 * (guest-role.ts), and the two agree on every enum value (drive-member-role.test.ts). Two guards
 * keep the next value from passing silently:
 * - compile time (exhaustiveness): MEMBERSHIP_OF must name every value of the database enum, so
 *   adding one to memberRole without classifying it here is a type error;
 * - run time (fail closed): a role nobody classified, or a row with no role, reads as NO membership
 *   and logs a warning. It never throws: a throw would turn one odd row into a 500 on a permission
 *   path (an outage anyone who can plant such a row could trigger) for the same security answer.
 */

type StoredDriveMemberRole = (typeof memberRole.enumValues)[number];

const MEMBERSHIP_OF: Readonly<Record<StoredDriveMemberRole, DriveMemberRole | null>> = {
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

/**
 * The membership a stored role grants, or null when the row is not a drive membership: a GUEST
 * row, or (fail closed, with a warning) a role nobody classified or no role at all.
 */
export function driveMembershipRole(role: string | null | undefined): DriveMemberRole | null {
  if (typeof role !== 'string' || !isClassified(role)) {
    loggers.api.warn('Unclassified drive member role read as no membership; classify it in permissions/drive-member-role.ts', {
      role: role ?? null,
    });
    return null;
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
