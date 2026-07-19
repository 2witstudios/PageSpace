/**
 * Pure decision core for channel incoming webhooks: payload validation and
 * sender-identity formatting. Zero I/O — no db, no fetch, no clock, no env —
 * enforced by the purity test in __tests__/channel-webhook-core.test.ts.
 * The imperative shell (channel-webhook-service.ts) owns every side effect.
 *
 * @module @pagespace/lib/services/channel-webhook-core
 */

import type { ChannelMessageAiMeta } from '@pagespace/db/schema/chat';

// Generous enough for real payloads (stack traces, release notes) while still
// bounding what a single POST can dump into a channel; 2x Discord's own 2000-char
// webhook content cap since PageSpace channel messages regularly carry longer
// markdown.
export const WEBHOOK_CONTENT_MAX_LENGTH = 4000;

// Discord's own webhook username cap.
export const WEBHOOK_USERNAME_MAX_LENGTH = 80;

export type WebhookPayloadValidation =
  | { ok: true; content: string; username?: string }
  | { ok: false; error: string };

/**
 * Validate an inbound webhook body (mirrors Discord's incoming-webhook payload
 * shape: `{ content, username? }`). Content is returned verbatim — the whole
 * point of the primitive is "the payload appears as a message, untouched" — so
 * emptiness is checked on the trimmed string but the original is preserved.
 * A whitespace-only username is normalized to absent so downstream identity
 * formatting falls back to the webhook's configured name.
 */
export function validateWebhookPayload(raw: unknown): WebhookPayloadValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'payload must be a JSON object' };
  }

  const { content, username } = raw as { content?: unknown; username?: unknown };

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
