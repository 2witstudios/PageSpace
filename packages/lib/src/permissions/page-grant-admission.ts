/**
 * Approved page grants (Spec POL-2): replay a direct page grant that the guests policy queued for approval.
 *
 * Sharing a page with an outsider (the page Share dialog, or a share-invite to an address that already has an
 * account) writes a page grant, which admits that person to the org drive's content as much as a drive invite does.
 * Under `approve` the grant is queued (origin `page_grant`, the flags in `request.permissions`) and nothing is
 * written; when an Owner or Admin approves, this writes exactly the grant that was asked, as the original sharer.
 */
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { pagePermissions } from '@pagespace/db/schema/members';
import { getDrivePolicies } from '../organizations/policy-reader';
import { reinsertHeldAccess, type ClaimedGuestApproval } from './guest-holds';

export type ApprovedPageGrant =
  | { ok: true; driveId: string; userId: string; pageIds: string[] }
  | { ok: false; error: 'NOT_A_PAGE_GRANT' | 'POLICY_OFF' | 'PAGE_GONE' };

/**
 * The queue row is already claimed by the caller, so nothing here can grant the same request twice. The org's
 * guests policy is read again (it may have turned off since the request) and only pages still in the drive are
 * granted; if none is left, nothing is.
 */
export async function completeApprovedPageGrant(claim: ClaimedGuestApproval): Promise<ApprovedPageGrant> {
  const asked = claim.request.permissions ?? [];
  const member = claim.request.member ?? null;
  const tokenScopes = claim.request.tokenScopes ?? [];
  if (claim.origin !== 'page_grant' || !claim.userId || (asked.length === 0 && !member && tokenScopes.length === 0)) return { ok: false, error: 'NOT_A_PAGE_GRANT' };
  const userId = claim.userId;

  return db.transaction(async (tx) => {
    // Read under the org row's share lock: a concurrent switch to OFF either parks this grant or is seen here.
    const policies = (await getDrivePolicies(claim.driveId, tx, { forShare: true }))?.policies ?? null;
    if (policies?.guests === 'off') return { ok: false, error: 'POLICY_OFF' } as const;

    const live = new Set(
      (asked.length === 0 ? [] : await tx.select({ id: pages.id }).from(pages).where(and(inArray(pages.id, asked.map((p) => p.pageId)), eq(pages.driveId, claim.driveId)))).map((p) => p.id),
    );
    const grants = asked.filter((p) => live.has(p.pageId));
    if (grants.length === 0 && !member && tokenScopes.length === 0) return { ok: false, error: 'PAGE_GONE' } as const;
    // Access the person already held before it was queued (a drive or pages moved into the org, a restore): their
    // member row and token scopes come back as they were.
    if (member || tokenScopes.length > 0) await reinsertHeldAccess(tx, claim.driveId, { member, grants: [], tokenScopes });
    // The sharer may have deleted their account while the request waited; the grant then has no granter, as a live
    // grant would after ON DELETE SET NULL.
    const invitedBy = claim.request.invitedBy ?? null;
    const sharer = invitedBy && (await tx.select({ id: users.id }).from(users).where(eq(users.id, invitedBy)).limit(1)).length > 0 ? invitedBy : null;
    for (const p of grants) {
      const flags = { canView: p.canView, canEdit: p.canEdit, canShare: p.canShare, canDelete: p.canDelete ?? false };
      const grantedBy = sharer;
      await tx
        .insert(pagePermissions)
        .values({ pageId: p.pageId, userId, ...flags, grantedBy, grantedAt: new Date() })
        .onConflictDoUpdate({ target: [pagePermissions.pageId, pagePermissions.userId], set: { ...flags, grantedBy, grantedAt: new Date() } });
    }
    return { ok: true, driveId: claim.driveId, userId, pageIds: grants.map((p) => p.pageId) } as const;
  });
}
