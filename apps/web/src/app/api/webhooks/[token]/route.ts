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

    // Resolve the enabled workflow triggers bound to this webhook once. The
    // count both suppresses the dispatcher's 'no action configured' write (a
    // page with triggers isn't a no-op) and decides the no-action vs triggers
    // 202. This is the single trigger lookup for the delivery.
    const triggerLookup = await findEnabledPageWebhookTriggers(webhook.id);
    if (!triggerLookup.success) {
      loggers.api.warn('Page webhook: trigger lookup failed', {
        webhookId: webhook.id,
        error: triggerLookup.error,
      });
    }
    const enabledTriggers = triggerLookup.success ? triggerLookup.data : [];

    const result = await dispatchWebhookDelivery({
      webhookId: webhook.id,
      pageId: webhook.pageId,
      payload: body,
      hasEnabledTriggers: enabledTriggers.length > 0,
    });

    // Fire bound workflows AFTER the HTTP response so the sender is never held
    // on AI latency — one signed delivery both runs its default page-type
    // action (above) AND fires any bound workflows. Skipped only for a delivery
    // that never reached a valid page: the dispatcher returns 'not_found'
    // BEFORE any handler for a trashed/missing target, and firing into the
    // trash makes no sense. A default-handler failure (rate limit, bad channel
    // payload) does NOT suppress the fan-out — the workflow envelope is
    // arbitrary JSON, independent of the channel handler's own contract.
    const reachedPage = !(result.kind === 'failed' && result.error === 'not_found');
    if (reachedPage && enabledTriggers.length > 0) {
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
