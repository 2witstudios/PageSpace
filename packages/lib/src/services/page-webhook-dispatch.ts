/**
 * Imperative dispatch shell for page incoming webhooks:
 * `dispatchWebhookDelivery()` — the single entry point the intake route calls
 * after signature verification.
 *
 * Every decision (envelope validation, the page-type → handler mapping) is
 * delegated to page-webhook-core.ts; this module only does I/O: the page
 * lookup (type + trashed state — a trashed/missing target 404s like an
 * unknown token), the handler invocation, and the lastFireError bookkeeping
 * on the no-action / bad-envelope paths. Never throws — the route maps
 * outcomes to status codes without a try/catch of its own.
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
import { pages } from '@pagespace/db/schema/core';
import {
  publishWebhookMessage,
  markWebhookFired,
  type PublishWebhookMessageResult,
} from './page-webhook-service';
import { loggers } from '../logging/logger-config';
import { PageType } from '../utils/enums';
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

/** A handler receives the full delivery context even if it only uses part of it, so a new handler never has to widen the contract. */
type WebhookHandler = (delivery: {
  webhookId: string;
  pageId: string;
  envelope: Record<string, unknown>;
}) => Promise<PublishWebhookMessageResult>;

const WEBHOOK_HANDLERS: Record<WebhookHandlerPageType, WebhookHandler> = {
  [PageType.CHANNEL]: ({ webhookId, envelope }) => publishWebhookMessage(webhookId, envelope),
};

/**
 * Dispatch a verified delivery to its page type's default handler. The route
 * has already read + size-capped the raw body, verified the signature, and
 * JSON-parsed the payload (null when unparseable — rejected here as a bad
 * envelope).
 */
export async function dispatchWebhookDelivery({
  webhookId,
  pageId,
  payload,
  hasEnabledTriggers = false,
}: {
  webhookId: string;
  pageId: string;
  payload: unknown;
  /**
   * True when the caller (the intake route) has resolved enabled workflow
   * triggers bound to this webhook and will fire them via `after()`. A page
   * with no default handler but firing triggers is NOT a no-op, so the
   * dispatcher suppresses its 'no action configured' bookkeeping write in that
   * case — the triggers are the delivery's action.
   */
  hasEnabledTriggers?: boolean;
}): Promise<WebhookDispatchResult> {
  try {
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { type: true, isTrashed: true },
    });
    // Minting is blocked on trashed pages, but a page can be trashed after its
    // webhook was created — a delivery must not keep writing into the trash.
    // Checked before payload validation and with no bookkeeping write, so a
    // trashed target is indistinguishable from an unknown/disabled token (the
    // route maps 'not_found' to the same generic 404).
    if (!page || page.isTrashed) {
      return { kind: 'failed', error: 'not_found' };
    }

    const validation = validateWebhookEnvelope(payload);
    if (!validation.ok) {
      await markWebhookFired(webhookId, validation.error);
      return { kind: 'failed', error: validation.error };
    }

    const handlerKey = resolveWebhookHandler(page.type);
    if (handlerKey === 'none') {
      // Only record 'no action configured' when there is genuinely nothing to
      // do. Firing workflow triggers count as the delivery's action even
      // without a default page-type handler.
      if (!hasEnabledTriggers) {
        await markWebhookFired(webhookId, 'no action configured');
      }
      return { kind: 'no_action' };
    }

    const result = await WEBHOOK_HANDLERS[handlerKey]({ webhookId, pageId, envelope: validation.envelope });
    return result.ok ? { kind: 'handled' } : { kind: 'failed', error: result.error };
  } catch (error) {
    loggers.system.error('page-webhook-dispatch: dispatchWebhookDelivery failed', error as Error, { webhookId });
    return { kind: 'failed', error: 'internal_error' };
  }
}
