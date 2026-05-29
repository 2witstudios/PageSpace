import type { ZoomConnection } from '@pagespace/db/schema/zoom';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  findMatchingWebhookTriggers,
  claimTriggerFired,
  setTriggerError,
} from './webhook-trigger-queries';
import { executeWebhookTrigger, type ZoomWebhookEvent } from './webhook-trigger-executor';

const logger = loggers.api.child({ module: 'fire-webhook-triggers' });

/**
 * Fan out a verified Zoom event to every enabled workflow trigger wired to it.
 *
 * The connection is pre-resolved by the caller (the webhook route resolves it
 * once and shares it with processZoomWebhook), so this makes zero connection
 * lookups. Composed from the pure query functions; never throws — a failing
 * lookup is logged and swallowed, and per-trigger failures are recorded via
 * setTriggerError without blocking the rest (Promise.allSettled).
 */
export async function fireZoomWebhookTriggers(
  event: ZoomWebhookEvent,
  connection: ZoomConnection,
): Promise<void> {
  const matched = await findMatchingWebhookTriggers(connection.id, event.event);
  if (!matched.success) {
    logger.warn('Webhook trigger lookup failed', {
      connectionId: connection.id,
      event: event.event,
      error: matched.error,
    });
    return;
  }

  if (matched.data.length === 0) return;

  await Promise.allSettled(
    matched.data.map(async (trigger) => {
      try {
        const result = await executeWebhookTrigger(trigger, event, connection);
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
