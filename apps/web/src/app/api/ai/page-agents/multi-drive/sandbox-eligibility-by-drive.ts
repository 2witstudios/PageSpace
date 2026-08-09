import { isSandboxAvailable } from '@pagespace/lib/billing/sandbox-eligibility';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

/**
 * Per-drive sandbox availability for THE REQUESTER: the payer's tier (the
 * drive's OWNER — not the requester's own plan) AND the requester's ability
 * to actually use it — drive edit access plus the code-execution kill switch
 * (review #2326: payer tier alone advertised shell affordances to
 * viewer-role members, and while the kill switch is off, that every
 * enforcement point then 403s). Pure so the batching/dedup logic is
 * unit-testable without a database: `multi-drive/route.ts` supplies the DB
 * reads (accessible drives, the distinct set of their owners' rows, the
 * requester's edit-capable memberships) already done.
 */
export function computeSandboxEligibilityByDrive(
  driveOwners: readonly { id: string; ownerId: string }[],
  ownerRows: readonly { id: string; subscriptionTier: string | null }[],
  actor: {
    userId: string;
    /** Drives where the requester holds an edit-capable membership (ADMIN/MEMBER role). Ownership is checked separately from `driveOwners`. */
    editableDriveIds: ReadonlySet<string>;
    codeExecutionEnabled: boolean;
  },
): Map<string, boolean> {
  const tierByOwnerId = new Map(ownerRows.map((row) => [row.id, toSubscriptionTier(row.subscriptionTier)]));
  return new Map(
    driveOwners.map((drive) => [
      drive.id,
      actor.codeExecutionEnabled &&
        isSandboxAvailable(tierByOwnerId.get(drive.ownerId) ?? 'free') &&
        (drive.ownerId === actor.userId || actor.editableDriveIds.has(drive.id)),
    ]),
  );
}

/**
 * Which of the requester's memberships carry DRIVE-WIDE edit — the same
 * answer `getUserDrivePermissions` gives, computed from batched rows so the
 * multi-drive listing needs two queries, not one per drive (codex round 13):
 * ADMINs always edit; a plain MEMBER edits; a MEMBER with a custom role
 * edits only when that role's driveWidePermissions grant canEdit explicitly
 * (an unresolvable role fails closed). Keyed strictly by (roleId, driveId)
 * so a role can never apply outside its own drive.
 */
export function resolveEditableDriveIds(
  membershipRows: readonly { driveId: string; role: string; customRoleId: string | null }[],
  customRoleRows: readonly { id: string; driveId: string; driveWidePermissions: { canEdit?: boolean } | null }[],
): Set<string> {
  const driveWideEditByRole = new Map(
    customRoleRows.map((row) => [`${row.id}:${row.driveId}`, row.driveWidePermissions?.canEdit === true]),
  );
  return new Set(
    membershipRows
      .filter((row) => {
        if (row.role === 'ADMIN') return true;
        if (row.role !== 'MEMBER') return false;
        if (!row.customRoleId) return true;
        return driveWideEditByRole.get(`${row.customRoleId}:${row.driveId}`) === true;
      })
      .map((row) => row.driveId),
  );
}
