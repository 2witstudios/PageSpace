/**
 * credit-liability-query — the IO shell for MON-7's credit liability. One GROUP BY over
 * every wallet by the columns that classify it (owner type, subject, parent, and the
 * owner's free tier); {@link foldCreditLiability} decides what each group counts as.
 * The admin billing panel reads it (apps/admin/src/lib/monitoring-queries.ts).
 */

import { db } from '@pagespace/db/db';
import { sql, count, eq, type SQL } from '@pagespace/db/operators';
import { wallets } from '@pagespace/db/schema/wallets';
import { users } from '@pagespace/db/schema/auth';
import { foldCreditLiability, type CreditLiabilityReport, type LiabilityGroup } from './credit-liability';

/**
 * The credit PageSpace owes across every wallet, point-in-time. `within` narrows the
 * wallets read (an integration test scopes to the rows it seeded in a shared database);
 * production passes nothing.
 */
export async function readCreditLiability(within?: SQL): Promise<CreditLiabilityReport> {
  const hasSubject = sql<boolean>`(${wallets.subjectType} IS NOT NULL)`;
  const hasParent = sql<boolean>`(${wallets.parentWalletId} IS NOT NULL)`;
  const freeTier = sql<boolean>`(COALESCE(${users.subscriptionTier}, '') = 'free')`;
  const rows = await db
    .select({
      ownerType: wallets.ownerType,
      hasSubject,
      hasParent,
      freeTier,
      monthlyRemainingCents: sql<number>`COALESCE(SUM(${wallets.monthlyRemainingCents}), 0)::double precision`,
      topupRemainingCents: sql<number>`COALESCE(SUM(${wallets.topupRemainingCents}), 0)::double precision`,
      walletCount: count(),
    })
    .from(wallets)
    .leftJoin(users, eq(users.id, wallets.userId))
    .where(within)
    .groupBy(wallets.ownerType, hasSubject, hasParent, freeTier);

  const groups: LiabilityGroup[] = rows.map((r) => ({
    ownerType: r.ownerType,
    hasSubject: Boolean(r.hasSubject),
    hasParent: Boolean(r.hasParent),
    freeTier: Boolean(r.freeTier),
    monthlyRemainingCents: Number(r.monthlyRemainingCents),
    topupRemainingCents: Number(r.topupRemainingCents),
    walletCount: Number(r.walletCount),
  }));
  return foldCreditLiability(groups);
}
