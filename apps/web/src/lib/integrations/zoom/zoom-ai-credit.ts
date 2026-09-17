import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Credit-gate one Zoom transcript AI call (summary / action items) on the
 * connection owner, like the zoom webhook trigger executor: server-triggered,
 * so skipDailyCap. A refusal (out of credits, an unclaimed agent's
 * requires_funding) returns `refused` without calling the model — the
 * transcript page is still created, just without AI enrichment. The hold is
 * released whether the call succeeds or throws.
 */
export async function withZoomAiCredit<T>(
  userId: string,
  feature: 'zoom_summary' | 'zoom_action_items',
  run: () => Promise<T>,
  refused: T,
): Promise<T> {
  const [owner] = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, userId));
  const gate = await canConsumeAI(userId, (owner?.subscriptionTier ?? 'free') as SubscriptionTier, {
    skipDailyCap: true,
  });
  if (!gate.allowed) {
    loggers.api.info('Zoom AI enrichment skipped (credit gate denied)', { userId, feature, reason: gate.reason });
    return refused;
  }
  try {
    return await run();
  } finally {
    if (gate.holdId) await releaseHold(gate.holdId);
  }
}
