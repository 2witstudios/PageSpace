/**
 * wallet-funders — WHO funds a wallet, and so is told when it is in debt (Spec WAL-6e).
 *
 * The money authority over a wallet is its owner's: for an ORG-owned wallet (the org pool, or
 * an org drive's wallet the pool funds) that is the org_admin standing wallet-access names —
 * the org's Owner and its Admins (ORG-4); for a person's wallet, that person. Accepted org
 * roles only: a pending invitation is not a membership and is never told anything.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { orgMembers } from '@pagespace/db/schema/organizations';

type Reader = Pick<typeof db, 'select'>;

/** The org roles that hold money authority over the org's wallets (wallet-access org_admin). */
export const ORG_WALLET_FUNDER_ROLES = ['OWNER', 'ADMIN'] as const;

/** The people who fund a wallet owned by `owner`, sorted for a stable fan-out. */
export async function walletFunderUserIds(
  executor: Reader,
  owner: { ownerType: 'user' | 'org'; userId: string | null; orgId: string | null },
): Promise<string[]> {
  if (owner.ownerType === 'user') return owner.userId ? [owner.userId] : [];
  if (!owner.orgId) return [];
  const rows = await executor
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, owner.orgId), inArray(orgMembers.role, [...ORG_WALLET_FUNDER_ROLES])));
  return rows.map((r) => r.userId).sort();
}
