/**
 * org-compute-epoch — the shell for the ONE instant org compute billing went live (WAL-9). The
 * rule is `org-compute-epoch-core.ts`; this only reads and stamps `billing_epochs`.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { billingEpochs } from '@pagespace/db/schema/credits';

export const ORG_COMPUTE_EPOCH_KEY = 'org_compute';

/**
 * The org compute billing epoch: stamped as `tickStart` by the first caller (any meter tick that
 * meets an org row), then read back unchanged forever after. Racing ticks agree — the insert is
 * ON CONFLICT DO NOTHING, and every caller reads the row that won.
 */
export async function stampOrgComputeBillingEpoch(tickStart: Date): Promise<Date> {
  await db.insert(billingEpochs).values({ key: ORG_COMPUTE_EPOCH_KEY, startedAt: tickStart }).onConflictDoNothing();
  const [row] = await db
    .select({ startedAt: billingEpochs.startedAt })
    .from(billingEpochs)
    .where(eq(billingEpochs.key, ORG_COMPUTE_EPOCH_KEY))
    .limit(1);
  // Unreachable after the insert above; fall back to the tick so nothing before it is charged.
  return row?.startedAt ?? tickStart;
}
