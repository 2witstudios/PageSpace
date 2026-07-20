/**
 * Imperative shell for page incoming webhooks: `publishWebhookMessage()`.
 *
 * Every decision (payload validation, sender-identity formatting) is delegated
 * to page-webhook-core.ts — this module only does I/O: the webhook-row
 * lookup, the rate-limit check, the channel-message insert, the realtime
 * broadcast, and the lastFiredAt/lastFireError bookkeeping. Called by the
 * inbound route (apps/web /api/webhooks/[token]) after it has verified
 * the request's HMAC signature. Never throws — an unexpected failure returns
 * an error result instead, so the route maps outcomes to status codes without
 * a try/catch of its own.
 *
 * Deliberately no dedupe/storm-control: a caller that floods a webhook just
 * gets rate-limit errors, same as Discord.
 *
 * @module @pagespace/lib/services/page-webhook-service
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pageWebhooks, SYSTEM_WEBHOOKS_USER_ID } from '@pagespace/db/schema/page-webhooks';
import { channelMessageRepository } from './channel-message-repository';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '../security/distributed-rate-limit';
import { createSignedBroadcastHeaders } from '../auth/broadcast-auth';
import { loggers } from '../logging/logger-config';
import { validateChannelWebhookPayload, formatWebhookSenderIdentity } from './page-webhook-core';

export type PublishWebhookMessageResult =
  | { ok: true }
  /** `error` is machine-readable for the route's status mapping ('not_found', 'rate_limited', 'channel_not_found', 'internal_error') or a validation message from the pure core. */
  | { ok: false; error: string };

/**
 * Broadcast a channel realtime event the same way the human message routes
 * do: signed POST to the realtime sidecar, 5s timeout, never throws (a
 * broadcast failure must not fail the publish — the message is already
 * persisted and will show up on next load).
 */
async function broadcastToChannel(channelId: string, payload: unknown): Promise<void> {
  if (!process.env.INTERNAL_REALTIME_URL) return;
  try {
    const requestBody = JSON.stringify({ channelId, event: 'new_message', payload });
    await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    loggers.system.error('page-webhook-service: failed to broadcast', error as Error, { channelId });
  }
}

/** Success clears lastFireError and stamps lastFiredAt; failure records the error without touching lastFiredAt. Best-effort. */
async function markWebhookFired(webhookId: string, error: string | null): Promise<void> {
  try {
    await db
      .update(pageWebhooks)
      .set(error === null ? { lastFiredAt: new Date(), lastFireError: null } : { lastFireError: error })
      .where(eq(pageWebhooks.id, webhookId));
  } catch (dbError) {
    loggers.system.error('page-webhook-service: failed to update fire status', dbError as Error, { webhookId });
  }
}

/**
 * Publish an inbound webhook payload as a channel message. The webhook is
 * looked up by id (the route already resolved the URL token to a row —
 * re-checking enabled/existence here is defense in depth against a stale id).
 */
export async function publishWebhookMessage(webhookId: string, rawPayload: unknown): Promise<PublishWebhookMessageResult> {
  try {
    const webhook = await db.query.pageWebhooks.findFirst({
      where: eq(pageWebhooks.id, webhookId),
    });
    if (!webhook || !webhook.isEnabled) {
      return { ok: false, error: 'not_found' };
    }

    const validation = validateChannelWebhookPayload(rawPayload);
    if (!validation.ok) {
      await markWebhookFired(webhookId, validation.error);
      return { ok: false, error: validation.error };
    }

    const rateLimit = await checkDistributedRateLimit(
      `page-webhook:${webhookId}`,
      DISTRIBUTED_RATE_LIMITS.PAGE_WEBHOOK,
    );
    if (!rateLimit.allowed) {
      await markWebhookFired(webhookId, 'rate_limited');
      return { ok: false, error: 'rate_limited' };
    }

    const result = await channelMessageRepository.insertChannelMessageWithAttachment({
      pageId: webhook.pageId,
      userId: SYSTEM_WEBHOOKS_USER_ID,
      content: validation.content,
      fileId: null,
      attachmentMeta: null,
      aiMeta: formatWebhookSenderIdentity(validation.username, webhook.name),
    });
    if (result.kind !== 'ok') {
      await markWebhookFired(webhookId, 'channel_not_found');
      return { ok: false, error: 'channel_not_found' };
    }

    await broadcastToChannel(
      webhook.pageId,
      await channelMessageRepository.loadChannelMessageWithRelations(result.message.id),
    );
    await markWebhookFired(webhookId, null);
    return { ok: true };
  } catch (error) {
    loggers.system.error('page-webhook-service: publishWebhookMessage failed', error as Error, { webhookId });
    return { ok: false, error: 'internal_error' };
  }
}
