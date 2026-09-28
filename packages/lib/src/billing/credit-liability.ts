/**
 * credit-liability — which wallets hold credit PageSpace still owes (Spec MON-7: admin
 * billing gains "included credit liability" = grants outstanding, distinct from cash).
 *
 * PURE: the IO shell (credit-liability-query.ts) groups wallet rows by the columns that
 * classify them and sums their buckets; this module decides what each group counts as.
 *
 * What counts (WAL-2 shapes):
 *   - personal root wallet (user-owned, no subject, no parent): its monthlyRemainingCents
 *     is that person's granted credit outstanding — the tier grant, or the free starter
 *     grant (reported separately as starterGrantIncludedCents, a subset, since it was
 *     never paid for). Its topupRemainingCents is purchased credit: liability, not a grant.
 *   - org pool (org-owned, no subject, no parent): its monthlyRemainingCents is the org's
 *     refilled grant (MON-3) outstanding, counted exactly as a personal root's. Before C5
 *     created pools the report read personal roots only and missed this (Review 2).
 *   - child wallet (a drive or agent wallet, under a pool or a personal root):
 *       · its allocation (monthlyAllowanceCents − spentCents) is NOT counted — it is a
 *         budget drawn on the parent as spend happens, so the parent still holds that
 *         money; counting it would count the pool twice.
 *       · its funding legs (topupRemainingCents = SUM of legs) ARE counted, in the total
 *         only: a top-up or donation moves money out of the payer root (monthly first)
 *         into the leg, so it is counted once, where it now sits. A leg does not record
 *         whether it came from a grant or a purchase, so it is not called "included".
 *       · a child never holds a grant bucket; a monthlyRemainingCents on one is ignored.
 */

export type LiabilityWalletKind = 'personal_root' | 'org_pool' | 'child';

export interface WalletShape {
  ownerType: 'user' | 'org';
  /** subjectType IS NOT NULL: a drive or agent wallet. */
  hasSubject: boolean;
  /** parentWalletId IS NOT NULL. */
  hasParent: boolean;
}

export function liabilityWalletKind(w: WalletShape): LiabilityWalletKind {
  if (w.hasSubject || w.hasParent) return 'child';
  return w.ownerType === 'org' ? 'org_pool' : 'personal_root';
}

/** One GROUP BY row from the shell: wallets sharing a shape (and, for personal roots, a free tier). */
export interface LiabilityGroup extends WalletShape {
  /** The owning user is on the free tier (personal roots only; false otherwise). */
  freeTier: boolean;
  monthlyRemainingCents: number;
  topupRemainingCents: number;
  walletCount: number;
}

export interface CreditLiabilityReport {
  /** Grants outstanding: personal roots' plus org pools' monthly buckets. */
  includedCreditLiabilityCents: number;
  personalIncludedCents: number;
  /** The part of personalIncludedCents held by free-tier accounts: the unpaid starter grant. */
  starterGrantIncludedCents: number;
  orgPoolIncludedCents: number;
  /** Purchased or moved-in credit on every wallet: root top-ups and child funding legs. */
  topupRemainingCents: number;
  /** includedCreditLiabilityCents + topupRemainingCents. */
  totalLiabilityCents: number;
  /** Personal root wallets (one per user). */
  userCount: number;
  orgPoolCount: number;
}

export function foldCreditLiability(groups: readonly LiabilityGroup[]): CreditLiabilityReport {
  let personal = 0;
  let starter = 0;
  let pools = 0;
  let topup = 0;
  let userCount = 0;
  let orgPoolCount = 0;
  for (const g of groups) {
    const monthly = Math.max(0, g.monthlyRemainingCents);
    topup += Math.max(0, g.topupRemainingCents);
    switch (liabilityWalletKind(g)) {
      case 'personal_root':
        personal += monthly;
        if (g.freeTier) starter += monthly;
        userCount += g.walletCount;
        break;
      case 'org_pool':
        pools += monthly;
        orgPoolCount += g.walletCount;
        break;
      case 'child':
        break;
    }
  }
  const included = personal + pools;
  return {
    includedCreditLiabilityCents: included,
    personalIncludedCents: personal,
    starterGrantIncludedCents: starter,
    orgPoolIncludedCents: pools,
    topupRemainingCents: topup,
    totalLiabilityCents: included + topup,
    userCount,
    orgPoolCount,
  };
}
