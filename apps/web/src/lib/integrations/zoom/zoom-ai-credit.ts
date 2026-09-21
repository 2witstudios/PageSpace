import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { classifyGateRefusal, type DeniedGateReason } from '@pagespace/lib/billing/classify-gate-refusal';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Waits before each re-gate after a TRANSIENT refusal. A transcript is
 * processed once, in the webhook's background task, and nothing re-runs it, so
 * a refusal that would clear on its own must not cost the transcript its
 * summary. The common case is a free owner (in-flight cap 2) whose summary,
 * action items and zoom-triggered workflows all gate at the same moment, or
 * who has chats streaming: those calls finish within a minute or so. The
 * retries are bounded, so a cap that never clears still falls back.
 */
export const ZOOM_AI_TRANSIENT_RETRY_DELAYS_MS = [15_000, 45_000] as const;

/**
 * Credit-gate one Zoom transcript AI call (summary / action items) on the
 * connection owner, like the zoom webhook trigger executor: server-triggered,
 * so skipDailyCap. A terminal refusal (out of credits, an unclaimed agent's
 * requires_funding) returns `refused` without calling the model — the
 * transcript page is still created, just without AI enrichment. A transient
 * refusal is re-gated after each ZOOM_AI_TRANSIENT_RETRY_DELAYS_MS delay first.
 * The hold is released whether the call succeeds or throws.
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
  const tier = (owner?.subscriptionTier ?? 'free') as SubscriptionTier;
  const acquire = () => canConsumeAI(userId, tier, { skipDailyCap: true });

  let gate = await acquire();
  for (const delayMs of ZOOM_AI_TRANSIENT_RETRY_DELAYS_MS) {
    if (gate.allowed || classifyGateRefusal(gate.reason as DeniedGateReason) !== 'transient') break;
    loggers.api.info('Zoom AI enrichment deferred (transient credit refusal)', { userId, feature, reason: gate.reason, delayMs });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    gate = await acquire();
  }
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
