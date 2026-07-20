import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { pages } from '@pagespace/db/schema/core';
import { decryptField } from '@pagespace/lib/encryption/field-crypto';
import { secureCompare } from '@pagespace/lib/auth/secure-compare';
import { publishWebhookMessage } from '@pagespace/lib/services/page-webhook-service';
import { loggers } from '@pagespace/lib/logging/logger-config';

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

// Arbitrary-JSON envelope cap — checked on the raw bytes BEFORE JSON.parse so
// an oversized body never costs a parse.
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Verify `x-pagespace-signature`/`x-pagespace-timestamp` the same way the
 * Zoom webhook does (`zoom/verify-webhook.ts`): HMAC-SHA256 over
 * `v0:{timestamp}:{rawBody}`, `secureCompare` for the comparison (never raw
 * `crypto.timingSafeEqual` on an unhashed secret — see secure-compare.ts),
 * and a 5-minute replay window.
 */
function verifySignature(signature: string | null, timestamp: string | null, rawBody: string, secret: string): boolean {
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > REPLAY_WINDOW_MS) return false;

  const message = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + createHmac('sha256', secret).update(message).digest('hex');
  return secureCompare(signature, expected);
}

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
    const signature = request.headers.get('x-pagespace-signature');
    const timestamp = request.headers.get('x-pagespace-timestamp');
    if (!verifySignature(signature, timestamp, rawBody, secret)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, webhook.pageId),
      columns: { type: true, isTrashed: true },
    });
    // Minting is blocked on trashed pages, but a page can be trashed after its
    // webhook was created — a delivery must not keep writing into the trash.
    // Same generic 404 as an unknown/disabled token: nothing leaks.
    if (!page || page.isTrashed) {
      return NOT_FOUND();
    }

    // Behavioral stub until the dispatch map lands: only CHANNEL pages have a
    // default action today. A verified delivery to any other page type is
    // accepted (the sender never breaks while wiring is in progress) but does
    // nothing, recorded on the row for the settings UI to surface.
    if (page.type !== 'CHANNEL') {
      await db
        .update(pageWebhooks)
        .set({ lastFireError: 'no action configured' })
        .where(eq(pageWebhooks.id, webhook.id));
      return NextResponse.json({ accepted: true, action: 'none' }, { status: 202 });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }

    const result = await publishWebhookMessage(webhook.id, body);
    if (result.ok) {
      return NextResponse.json({ ok: true });
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
