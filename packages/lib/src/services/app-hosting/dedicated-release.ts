/**
 * dedicated-release — when a drive changes payer, its former payer stops paying for its apps'
 * dedicated hosting at the end of the period already paid for (WAL-9, D-OW-64): an org whose
 * drive leaves it (a move out, or the org's deletion), or a person whose drive moves into an org
 * (the org buys its own). Written to the Stripe reclaim OUTBOX inside the move's own transaction,
 * as `cancelAt: 'period_end'`, so the move and the release commit together or not at all; the
 * drain cron makes the Stripe call. The decision is the pure `dedicatedSubscriptionsToRelease`;
 * this file is only its IO.
 */
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { publishedAppSubscriptions } from '@pagespace/db/schema/published-app-subscriptions';
import { appHostingStripeReclaims } from '@pagespace/db/schema/app-hosting-stripe-reclaims';
import { dedicatedSubscriptionsToRelease } from './dedicated-tier';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Queue every live dedicated subscription the drive's former payer pays for on its apps to end at period end. Returns their ids. */
export async function releaseDedicatedHostingInTx(
  tx: Tx,
  input: { driveId: string; formerPayer: { kind: 'org'; orgId: string } | { kind: 'user' } },
): Promise<string[]> {
  const rows = await tx
    .select({
      stripeSubscriptionId: publishedAppSubscriptions.stripeSubscriptionId,
      publishedAppId: publishedAppSubscriptions.publishedAppId,
      orgId: publishedAppSubscriptions.orgId,
      status: publishedAppSubscriptions.status,
    })
    .from(publishedAppSubscriptions)
    .innerJoin(publishedApps, eq(publishedApps.id, publishedAppSubscriptions.publishedAppId))
    .where(eq(publishedApps.driveId, input.driveId));
  const release = dedicatedSubscriptionsToRelease(rows, input.formerPayer);
  if (release.length === 0) return [];
  // DO NOTHING on conflict: a pending immediate cancel (the app is being destroyed) is never
  // softened to period end.
  await tx
    .insert(appHostingStripeReclaims)
    .values(release.map((row) => ({ stripeSubscriptionId: row.stripeSubscriptionId, publishedAppId: row.publishedAppId, cancelAt: 'period_end' })))
    .onConflictDoNothing();
  return release.map((row) => row.stripeSubscriptionId);
}
