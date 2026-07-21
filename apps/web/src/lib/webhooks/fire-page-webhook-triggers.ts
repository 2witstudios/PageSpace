import type { WebhookTrigger } from '@pagespace/db/schema/webhook-triggers';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { claimTriggerFired, setTriggerError } from './page-webhook-trigger-queries';
import { executePageWebhookTrigger } from './page-webhook-trigger-executor';

const logger = loggers.api.child({ module: 'fire-page-webhook-triggers' });

/**
 * Fan out a verified page-webhook delivery to every enabled workflow trigger
 * bound to it — the page-anchored mirror of fireZoomWebhookTriggers.
 *
 * The trigger rows are pre-resolved by the caller: the intake route looks them
 * up once (it needs the count to decide the no-action 202) and shares the list
 * here, exactly as the Zoom route pre-resolves the connection. This runs inside
 * `after()`, so the sender already has its HTTP response — the AI latency here
 * never blocks the delivery.
 *
 * Never throws: per-trigger failures are isolated (Promise.allSettled) and
 * recorded via setTriggerError; a success stamps lastFiredAt via
 * claimTriggerFired — identical bookkeeping to Zoom's.
 */
export async function firePageWebhookTriggers(
  triggers: WebhookTrigger[],
  envelope: unknown,
): Promise<void> {
  if (triggers.length === 0) return;

  await Promise.allSettled(
    triggers.map(async (trigger) => {
      try {
        // Per-WEBHOOK AI budget, drawn once per attempted run BEFORE the
        // per-trigger bucket. The per-trigger limit alone does not bound
        // aggregate spend — one webhook can bind up to 100 triggers, each with
        // its own 5/min bucket — so every run attempt (allowed or not further
        // down) consumes from the shared budget keyed by the webhook id. A
        // leaked webhook secret is thereby a bounded incident: at most the
        // budget's ceiling of runs per window across ALL bound triggers.
        if (trigger.pageWebhookId) {
          const budget = await checkDistributedRateLimit(
            `page-webhook-ai-budget:${trigger.pageWebhookId}`,
            DISTRIBUTED_RATE_LIMITS.PAGE_WEBHOOK_AI_BUDGET,
          );
          if (!budget.allowed) {
            logger.warn('Page webhook trigger: webhook AI budget exhausted', {
              triggerId: trigger.id,
              pageWebhookId: trigger.pageWebhookId,
            });
            await setTriggerError(trigger.id, 'rate_limited');
            return;
          }
        }

        // Per-trigger rate limit, TIGHTER than the channel-post path (an AI run
        // costs ~1000x a message insert). On top of executeWorkflow's
        // single-running claim, this bounds the run RATE for a runaway sender.
        const rl = await checkDistributedRateLimit(
          `page-webhook-trigger:${trigger.id}`,
          DISTRIBUTED_RATE_LIMITS.PAGE_WEBHOOK_TRIGGER,
        );
        if (!rl.allowed) {
          logger.warn('Page webhook trigger: rate limited', { triggerId: trigger.id });
          await setTriggerError(trigger.id, 'rate_limited');
          return;
        }

        const result = await executePageWebhookTrigger(trigger, envelope);
        if (result.success) {
          await claimTriggerFired(trigger.id);
        } else {
          await setTriggerError(trigger.id, result.error ?? 'Workflow execution failed');
        }
      } catch (e) {
        await setTriggerError(trigger.id, e instanceof Error ? e.message : String(e));
      }
    }),
  );
}
