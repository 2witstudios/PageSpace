import type { OpenRoleFloor } from '../organizations/policies-core';
import type { PermissionLevel } from './permissions';

/**
 * POL-6 at RESOLUTION time: the org's floor under its Open drives, applied to what a resolver has already
 * decided. The one function every human resolver path calls on an implicit Open-drive membership, so the floor
 * holds however the data got below it: a default role written before the write guards (open-role-floor.ts), a
 * per-page entry on the default (Review #2762 P2-4), an org row frozen on a former default (P2-3), or an
 * explicit page grant below the floor. The write guards stay; this makes the floor a read-time guarantee too.
 *
 * - `floor` is the membership's `openDriveFloor` (resolveEffectiveDriveMembership): the org's floor when the
 *   access comes from the implicit org membership (an org MEMBER, source `org`, on an OPEN drive), else null. A
 *   null floor returns the answer unchanged, so an explicit role, a guest, a pending invite, an outsider and a
 *   RESTRICTED or PRIVATE drive are never raised.
 * - The floor RAISES, never lowers: each flag is the answer's OR the floor's. The floor grants view (`view`), or
 *   view and edit (`edit`); never share or delete.
 * - A private page is never opened by the floor. Privacy is the page's own "explicit grants only" rule, which no
 *   drive-wide grant crosses (not the plain member's, not a role's drive-wide permissions), and the floor is the
 *   least the default role grants drive-wide.
 * - The drive root (drive-as-root-node) is a non-private target: its canEdit is the drive-wide edit question.
 *
 * Pure.
 */
export function applyOpenDriveFloor(
  effective: PermissionLevel | null,
  floor: OpenRoleFloor | null,
  target: { isPrivate: boolean },
): PermissionLevel | null {
  if (floor === null || target.isPrivate) return effective;
  return {
    canView: true,
    canEdit: (effective?.canEdit ?? false) || floor === 'edit',
    canShare: effective?.canShare ?? false,
    canDelete: effective?.canDelete ?? false,
  };
}
