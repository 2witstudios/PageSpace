import { createHmac, randomUUID } from 'crypto';

/**
 * Forge the headers `validateSignedCronRequest` expects (apps/web/src/lib/auth/cron-auth.ts):
 *   message   = `${timestamp}:${nonce}:${method}:${path}`
 *   signature = HMAC-SHA256(CRON_SECRET, message) hex
 * Timestamp is unix seconds and must be within the 300s skew window; nonce must be unique.
 */
export function cronHeaders(opts: { method?: string; path: string; secret?: string }): Record<string, string> {
  const secret = opts.secret ?? process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET is required to sign cron requests');
  const method = opts.method ?? 'POST';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const message = `${timestamp}:${nonce}:${method}:${opts.path}`;
  const signature = createHmac('sha256', secret).update(message).digest('hex');
  return {
    'X-Cron-Timestamp': timestamp,
    'X-Cron-Nonce': nonce,
    'X-Cron-Signature': signature,
  };
}

/**
 * Build a Stripe-compatible `stripe-signature` header for a raw JSON payload, matching
 * what `stripe.webhooks.constructEvent` verifies:
 *   signed_payload = `${t}.${payload}`
 *   v1             = HMAC-SHA256(STRIPE_WEBHOOK_SECRET, signed_payload) hex
 *   header         = `t=${t},v1=${v1}`
 */
export function stripeSignature(payload: string, secret = process.env.STRIPE_WEBHOOK_SECRET): string {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is required to sign webhook events');
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** A minimal Stripe `checkout.session.completed` event for a credit-pack top-up. */
export function creditPackEvent(opts: {
  eventId: string;
  userId: string;
  packId: string;
  packCents: number;
  sessionId?: string;
}): Record<string, unknown> {
  return {
    id: opts.eventId,
    object: 'event',
    type: 'checkout.session.completed',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: opts.sessionId ?? `cs_test_${opts.eventId}`,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        status: 'complete',
        metadata: {
          kind: 'credit_pack',
          packId: opts.packId,
          packCents: String(opts.packCents),
          userId: opts.userId,
        },
      },
    },
  };
}
