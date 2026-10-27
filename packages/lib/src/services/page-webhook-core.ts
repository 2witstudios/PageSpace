/**
 * Pure decision core for page incoming webhooks: envelope validation, the
 * per-page-type dispatch decision, per-handler payload schemas, and
 * sender-identity formatting. Zero I/O — no db, no fetch, no clock, no env —
 * enforced by the purity test in __tests__/page-webhook-core.test.ts.
 * The imperative shells (page-webhook-dispatch.ts, page-webhook-service.ts)
 * own every side effect.
 *
 * The envelope schema (any JSON object) is deliberately separate from the
 * per-handler schemas (e.g. the CHANNEL handler's Discord-shaped payload):
 * the envelope is the universal intake contract, a handler schema is one
 * page type's opinion about what's inside it.
 *
 * @module @pagespace/lib/services/page-webhook-core
 */

import type { ChannelMessageAiMeta } from '@pagespace/db/schema/chat';
import { PageType } from '../utils/enums';

/**
 * Page types with a built-in default webhook action. This tuple plus the
 * matching entry in WEBHOOK_HANDLERS (page-webhook-dispatch.ts, typed
 * Record<WebhookHandlerPageType, …> so the compiler rejects a key without a
 * handler) is ALL it takes to give a page type a default action — no route or
 * dispatcher plumbing changes. Keys are PageType members, so an entry that
 * isn't a real page type is a compile error too.
 */
export const WEBHOOK_HANDLER_PAGE_TYPES = [PageType.CHANNEL] as const;

export type WebhookHandlerPageType = (typeof WEBHOOK_HANDLER_PAGE_TYPES)[number];

export type WebhookEnvelopeValidation =
  | { ok: true; envelope: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validate the universal delivery envelope: any JSON object (the route has
 * already capped the raw body at 64KB). Arrays and scalars are rejected so
 * every handler schema can assume a keyed object.
 */
export function validateWebhookEnvelope(raw: unknown): WebhookEnvelopeValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'payload must be a JSON object' };
  }
  return { ok: true, envelope: raw as Record<string, unknown> };
}

/**
 * The pure dispatch decision: which handler (if any) a page type's deliveries
 * run. 'none' is a real outcome, not an error — the route answers 202 and the
 * row records 'no action configured'.
 */
export function resolveWebhookHandler(pageType: string | null | undefined): WebhookHandlerPageType | 'none' {
  return WEBHOOK_HANDLER_PAGE_TYPES.find((handlerType) => handlerType === pageType) ?? 'none';
}

// Generous enough for real payloads (stack traces, release notes) while still
// bounding what a single POST can dump into a channel; 2x Discord's own 2000-char
// webhook content cap since PageSpace channel messages regularly carry longer
// markdown.
export const WEBHOOK_CONTENT_MAX_LENGTH = 4000;

// Discord's own webhook username cap.
export const WEBHOOK_USERNAME_MAX_LENGTH = 80;

export type ChannelWebhookPayloadValidation =
  | { ok: true; content: string; username?: string }
  | { ok: false; error: string };

/**
 * The CHANNEL handler's payload schema (mirrors Discord's incoming-webhook
 * shape: `{ content, username? }`). Content is returned verbatim — the whole
 * point of the primitive is "the payload appears as a message, untouched" — so
 * emptiness is checked on the trimmed string but the original is preserved.
 * A whitespace-only username is normalized to absent so downstream identity
 * formatting falls back to the webhook's configured name. Standalone strict —
 * it re-runs envelope validation so the publish service stays safe to call
 * without going through the dispatcher first.
 */
export function validateChannelWebhookPayload(raw: unknown): ChannelWebhookPayloadValidation {
  const envelope = validateWebhookEnvelope(raw);
  if (!envelope.ok) {
    return envelope;
  }

  const { content, username } = envelope.envelope as { content?: unknown; username?: unknown };

  if (typeof content !== 'string') {
    return { ok: false, error: 'content is required and must be a string' };
  }
  if (content.trim().length === 0) {
    return { ok: false, error: 'content must not be empty' };
  }
  if (content.length > WEBHOOK_CONTENT_MAX_LENGTH) {
    return { ok: false, error: `content must be at most ${WEBHOOK_CONTENT_MAX_LENGTH} characters` };
  }

  if (username !== undefined && typeof username !== 'string') {
    return { ok: false, error: 'username must be a string' };
  }
  if (typeof username === 'string' && username.length > WEBHOOK_USERNAME_MAX_LENGTH) {
    return { ok: false, error: `username must be at most ${WEBHOOK_USERNAME_MAX_LENGTH} characters` };
  }

  const normalizedUsername = typeof username === 'string' && username.trim().length > 0 ? username : undefined;
  return { ok: true, content, username: normalizedUsername };
}

/**
 * The displayed sender identity for a webhook-posted message. Discord's rule:
 * an explicit `username` in the payload overrides the webhook's configured
 * name; otherwise the webhook's own name is used.
 */
export function formatWebhookSenderIdentity(username?: string, webhookName?: string): ChannelMessageAiMeta {
  const senderName =
    (username && username.trim().length > 0 ? username : undefined) ??
    (webhookName && webhookName.trim().length > 0 ? webhookName : undefined) ??
    'Webhook';
  return { senderType: 'webhook', senderName };
}
