import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { channelWebhooks } from '@pagespace/db/schema/channel-webhooks';
import { decryptField } from '@pagespace/lib/encryption/field-crypto';
import { secureCompare } from '@pagespace/lib/auth/secure-compare';
import { publishWebhookMessage } from '@pagespace/lib/services/channel-webhook-service';
import { loggers } from '@pagespace/lib/logging/logger-config';

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

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

// POST /api/webhooks/channel/[token] — signed intake for a channel incoming webhook.
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const rawBody = await request.text();

    const webhook = await db.query.channelWebhooks.findFirst({
      where: eq(channelWebhooks.webhookToken, token),
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
    loggers.api.error('Error handling inbound channel webhook', error as Error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
