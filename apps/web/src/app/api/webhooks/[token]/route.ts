import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { decryptField } from '@pagespace/lib/encryption/field-crypto';
import { v0Scheme, DEFAULT_REPLAY_WINDOW_MS } from '@pagespace/lib/security/webhook-signature';
import { dispatchWebhookDelivery } from '@pagespace/lib/services/page-webhook-dispatch';
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

    const result = await dispatchWebhookDelivery({ webhookId: webhook.id, pageId: webhook.pageId, payload: body });
    if (result.kind === 'handled') {
      return NextResponse.json({ ok: true });
    }
    // A verified delivery to a page type with no default handler is accepted —
    // the sender never breaks while wiring is in progress; the dispatcher has
    // recorded 'no action configured' on the row for the settings UI to surface.
    if (result.kind === 'no_action') {
      return NextResponse.json({ accepted: true, action: 'none' }, { status: 202 });
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
