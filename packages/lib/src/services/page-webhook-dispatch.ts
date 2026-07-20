/**
 * Imperative dispatch shell for page incoming webhooks:
 * `dispatchWebhookDelivery()` — the single entry point the intake route calls
 * after signature verification.
 *
 * Every decision (envelope validation, the page-type → handler mapping) is
 * delegated to page-webhook-core.ts; this module only does I/O: the page-type
 * lookup, the handler invocation, and the lastFireError bookkeeping on the
 * no-action / bad-envelope paths. Never throws — the route maps outcomes to
 * status codes without a try/catch of its own.
 *
 * WEBHOOK_HANDLERS is the whole extension surface: giving a page type a
 * default action means adding its key to WEBHOOK_HANDLER_PAGE_TYPES
 * (page-webhook-core.ts) and its handler entry below — the Record type makes
 * one without the other a compile error, and nothing else changes.
 *
 * @module @pagespace/lib/services/page-webhook-dispatch
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { pages } from '@pagespace/db/schema/core';
import { publishWebhookMessage } from './page-webhook-service';
import { loggers } from '../logging/logger-config';
import {
  validateWebhookEnvelope,
  resolveWebhookHandler,
  type WebhookHandlerPageType,
} from './page-webhook-core';

export type WebhookDispatchResult =
  /** The page type's handler ran and succeeded. */
  | { kind: 'handled' }
  /** No handler for the page type — the route answers 202 {accepted, action: 'none'}. */
  | { kind: 'no_action' }
  /** `error` is machine-readable for the route's status mapping ('not_found', 'rate_limited', 'channel_not_found', 'internal_error') or a validation message from the pure core. */
  | { kind: 'failed'; error: string };

type WebhookHandler = (delivery: {
  webhookId: string;
  envelope: Record<string, unknown>;
}) => Promise<{ ok: true } | { ok: false; error: string }>;

const WEBHOOK_HANDLERS: Record<WebhookHandlerPageType, WebhookHandler> = {
  CHANNEL: ({ webhookId, envelope }) => publishWebhookMessage(webhookId, envelope),
};

/** Best-effort lastFireError bookkeeping for outcomes decided here (bad envelope, no action); handlers own their own. */
async function recordFireError(webhookId: string, error: string): Promise<void> {
  try {
    await db.update(pageWebhooks).set({ lastFireError: error }).where(eq(pageWebhooks.id, webhookId));
  } catch (dbError) {
    loggers.system.error('page-webhook-dispatch: failed to record fire error', dbError as Error, { webhookId });
  }
}

/**
 * Dispatch a verified delivery to its page type's default handler. The route
 * has already read + size-capped the raw body, verified the signature, and
 * JSON-parsed the payload (null when unparseable — rejected here as a bad
 * envelope).
 */
export async function dispatchWebhookDelivery(delivery: {
  webhookId: string;
  pageId: string;
  payload: unknown;
}): Promise<WebhookDispatchResult> {
  const { webhookId, pageId, payload } = delivery;
  try {
    const validation = validateWebhookEnvelope(payload);
    if (!validation.ok) {
      await recordFireError(webhookId, validation.error);
      return { kind: 'failed', error: validation.error };
    }

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { type: true },
    });

    const handlerKey = resolveWebhookHandler(page?.type);
    if (handlerKey === 'none') {
      await recordFireError(webhookId, 'no action configured');
      return { kind: 'no_action' };
    }

    const result = await WEBHOOK_HANDLERS[handlerKey]({ webhookId, envelope: validation.envelope });
    return result.ok ? { kind: 'handled' } : { kind: 'failed', error: result.error };
  } catch (error) {
    loggers.system.error('page-webhook-dispatch: dispatchWebhookDelivery failed', error as Error, { webhookId });
    return { kind: 'failed', error: 'internal_error' };
  }
}
