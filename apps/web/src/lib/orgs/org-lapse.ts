/**
 * What a lapsed org may still change (SEAT-9 as amended by D-OW-33: restricting works, loosening is
 * paused). The UI disables exactly what the routes would refuse, using lib's own rules, so the two
 * never disagree: loosenedPolicyKeys for policies, capChangeOnlyRestricts for seat caps,
 * visibilityChangeOnlyRestricts for drive visibility and roleChangeOnlyRestricts for org roles.
 */
import type { OrgBillingNotice } from '@pagespace/lib/organizations/status-core';
import { loosenedPolicyKeys, type OrgPolicies, type OrgPoliciesPatch } from '@pagespace/lib/organizations/policies-core';
import { capChangeOnlyRestricts } from '@pagespace/lib/billing/wallet-admin';
import { visibilityChangeOnlyRestricts } from '@pagespace/lib/organizations/org-drive-ownership';
import { roleChangeOnlyRestricts } from '@pagespace/lib/organizations/org-roles';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import type { OrgRole } from '@pagespace/db/schema/organizations';

/** The routes answer a lapsed org's notice as reactivate (Owner/Admin) or read_only (Member). */
export const orgIsLapsed = (notice: OrgBillingNotice | undefined): boolean =>
  notice?.kind === 'reactivate' || notice?.kind === 'read_only';

/** While lapsed a drive may only be made less open (Private < Restricted < Open), as changeDriveVisibility judges it. */
export const visibilityChangeAllowed = (lapsed: boolean, from: OrgDriveVisibility, to: OrgDriveVisibility): boolean =>
  !lapsed || visibilityChangeOnlyRestricts(from, to);

/** While lapsed an org role may only be lowered, as changeMemberRole judges it. */
export const roleChangeAllowed = (lapsed: boolean, from: OrgRole, to: OrgRole): boolean =>
  !lapsed || roleChangeOnlyRestricts(from, to);

export function policyChangeAllowed(lapsed: boolean, current: OrgPolicies, patch: OrgPoliciesPatch): boolean {
  return !lapsed || loosenedPolicyKeys(current, { ...current, ...patch }).length === 0;
}

/**
 * A seat cap change while lapsed: compared on EFFECTIVE limits, where a seat's missing monthly cap is
 * the seat allowance (WAL-2), exactly as the seat-cap route judges it.
 */
export function seatCapChangeAllowed(
  lapsed: boolean,
  seat: { dailyCapCents: number | null; monthlyLimitCents: number },
  next: { dailyCapCents: number | null; monthlyCapCents: number | null },
  seatAllowanceCents: number,
): boolean {
  if (!lapsed) return true;
  return capChangeOnlyRestricts(
    { dailyCents: seat.dailyCapCents, monthlyCents: seat.monthlyLimitCents },
    { dailyCents: next.dailyCapCents, monthlyCents: next.monthlyCapCents ?? seatAllowanceCents },
  );
}
