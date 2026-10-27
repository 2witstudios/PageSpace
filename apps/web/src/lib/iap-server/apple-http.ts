/**
 * Pure HTTP mapping for the App Store routes (apps/web/src/app/api/iap/apple/*).
 *
 * The device finishes a StoreKit transaction only on a response that will never change
 * on retry — 2xx (applied / already applied), 400 (it will never verify) and 422 (a
 * permanent refusal, e.g. it belongs to another account, whose server notification
 * still credits the real buyer). Anything that could succeed later — a 503 while the
 * verifier is unconfigured or Apple's OCSP is unreachable, a 500 — leaves it unfinished
 * so StoreKit redelivers it.
 *
 * Apple redelivers a notification on any non-2xx, so the notification mapping returns
 * 200 for everything that has been dealt with (including a refusal, which retrying cannot
 * change) and 5xx only for what a retry could fix — an unresolved buyer among them.
 */

import type { AppleVerificationFailure } from '@pagespace/lib/billing/apple/apple-verify';
import type { AppleApplyResult, AppleNotificationResult } from '@pagespace/lib/billing/apple/apple-funding';

export interface HttpReply {
  status: number;
  body: Record<string, unknown>;
}

/** Map a verification failure to a reply. */
export function verificationFailureReply(failure: AppleVerificationFailure): HttpReply {
  switch (failure) {
    case 'malformed':
    case 'invalid_signature':
      return { status: 400, body: { error: 'invalid_transaction' } };
    case 'not_configured':
    case 'retryable':
      return { status: 503, body: { error: 'verification_unavailable' } };
  }
}

/** Map an applied device transaction to a reply. */
export function transactionReply(result: AppleApplyResult): HttpReply {
  if (result.result === 'refused') {
    return { status: 422, body: { error: 'refused', reason: result.reason } };
  }
  return { status: 200, body: { result: result.result, kind: result.kind, subscriptionTier: result.subscriptionTier } };
}

/**
 * Ack a notification's final outcome with 200. The one exception is a buyer we cannot
 * resolve yet: answer 503 so Apple redelivers (it retries for days) — by then the device
 * may have synced the purchase, linking it to its account.
 */
export function notificationReply(result: AppleNotificationResult): HttpReply {
  if (result.result === 'refused' && result.reason === 'unknown_user') {
    return { status: 503, body: { error: 'buyer_not_found' } };
  }
  return { status: 200, body: { received: true, result: result.result } };
}

/** Parse `{ [field]: string }` out of an untrusted JSON body. */
export function readJwsField(body: unknown, field: 'signedTransaction' | 'signedPayload'): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string') return null;
  // A JWS is three base64url segments; StoreKit's are a few KB. Refuse anything else early.
  if (value.length === 0 || value.length > 64_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return null;
  return value;
}
/**
 * Which store holds the user's paid personal plan: a contract that entitles now or is still
 * collecting a failed renewal. Stripe first when both do (it is the one the web can
 * manage); null when neither does.
 */
export function resolveBillingProvider(input: {
  stripeContract: boolean;
  appleContract: boolean;
}): 'stripe' | 'apple' | null {
  if (input.stripeContract) return 'stripe';
  if (input.appleContract) return 'apple';
  return null;
}
