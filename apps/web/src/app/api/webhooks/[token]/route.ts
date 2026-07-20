import { NextResponse, after } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { decryptField } from '@pagespace/lib/encryption/field-crypto';
import { v0Scheme, DEFAULT_REPLAY_WINDOW_MS } from '@pagespace/lib/security/webhook-signature';
import { dispatchWebhookDelivery } from '@pagespace/lib/services/page-webhook-dispatch';
import { findEnabledPageWebhookTriggers } from '@/lib/webhooks/page-webhook-trigger-queries';
import { firePageWebhookTriggers } from '@/lib/webhooks/fire-page-webhook-triggers';
import { loggers } from '@pagespace/lib/logging/logger-config';

// Arbitrary-JSON envelope cap — checked on the raw bytes BEFORE JSON.parse so
// an oversized body never costs a parse.
const MAX_BODY_BYTES = 64 * 1024;

const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

// POST /api/webhooks/[token] — signed intake for a page incoming webhook.
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const rawBody = await request.text();

    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }

    const webhook = await db.query.pageWebhooks.findFirst({
      where: eq(pageWebhooks.webhookToken, token),
    });

    // A single generic 404 whether the token never existed or is disabled —
    // never reveal which, so a token can't be probed for existence.
    if (!webhook || !webhook.isEnabled) {
      return NOT_FOUND();
    }

    const secret = await decryptField(webhook.webhookSecretEncrypted);
    const verified = v0Scheme.verify({
      secret,
      signature: request.headers.get('x-pagespace-signature'),
      timestamp: request.headers.get('x-pagespace-timestamp'),
      rawBody,
      nowMs: Date.now(),
      replayWindowMs: DEFAULT_REPLAY_WINDOW_MS,
    });
    if (!verified) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }

    // Resolve the enabled workflow triggers bound to this webhook once, BEFORE
    // dispatch. The count tells the dispatcher a page with triggers isn't a
    // no-op (it records the delivery as fired instead of 'no action configured')
    // and decides the route's no-action vs triggers 202.
    //
    // A transient failure here must NOT be silently treated as "no triggers":
    // that would drop every bound workflow while returning a 2xx the sender
    // won't retry (and mis-report action:'none' on a no-handler page). Reject
    // the whole delivery as retryable (5xx) BEFORE dispatch, so no channel post
    // happens either and the sender's retry can't duplicate it — a healthy
    // retry then resolves the triggers and dispatches both actions. (v1 has no
    // durable delivery queue; retry is the at-least-once mechanism.)
    const triggerLookup = await findEnabledPageWebhookTriggers(webhook.id);
    if (!triggerLookup.success) {
      loggers.api.error('Page webhook: trigger lookup failed — returning retryable 503', {
        webhookId: webhook.id,
        error: triggerLookup.error,
      });
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    }
    const enabledTriggers = triggerLookup.data;

    const result = await dispatchWebhookDelivery({
      webhookId: webhook.id,
      pageId: webhook.pageId,
      payload: body,
      hasEnabledTriggers: enabledTriggers.length > 0,
    });

    // Fire bound workflows AFTER the HTTP response so the sender is never held
    // on AI latency — one signed delivery both runs its default page-type
    // action (above) AND fires any bound workflows. Gated on an ACCEPTED (2xx)
    // delivery only: 'handled' (default action ran) or 'no_action' (no default
    // handler). Every 'failed' outcome — a malformed/rejected envelope (400), a
    // rate limit (429), a trashed/missing page (404), an internal error (500) —
    // is a non-2xx the sender is expected to RETRY, so firing AI/tool side
    // effects there would both act on a rejected delivery and duplicate on the
    // retry. A valid delivery to a channel with bound triggers still composes:
    // it posts (handled → 200) AND fires; an arbitrary-JSON delivery to a
    // no-handler page fires via no_action → 202.
    const deliveryAccepted = result.kind === 'handled' || result.kind === 'no_action';
    if (deliveryAccepted && enabledTriggers.length > 0) {
      after(() => firePageWebhookTriggers(enabledTriggers, body));
    }

    if (result.kind === 'handled') {
      return NextResponse.json({ ok: true });
    }
    if (result.kind === 'no_action') {
      // No default handler for this page type. If workflow triggers are firing,
      // the delivery still has an action; only a webhook with neither is truly
      // 'no action configured' (recorded on the row by the dispatcher).
      return enabledTriggers.length > 0
        ? NextResponse.json({ accepted: true, action: 'triggers' }, { status: 202 })
        : NextResponse.json({ accepted: true, action: 'none' }, { status: 202 });
    }

    switch (result.error) {
      case 'not_found':
      case 'channel_not_found':
        return NOT_FOUND();
      case 'rate_limited':
        return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
      case 'internal_error':
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
      default:
        // Anything else is a payload-validation message from the pure core.
        return NextResponse.json({ error: result.error }, { status: 400 });
    }
  } catch (error) {
    loggers.api.error('Error handling inbound page webhook', error as Error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
