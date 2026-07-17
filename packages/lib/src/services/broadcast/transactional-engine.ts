/**
 * The Phase-1 engine: one rate-limited, individually-addressed send per recipient.
 *
 * This is the path the SDK/CLI launch email actually shipped on, promoted from a script
 * into something a worker can drive. Per-recipient sending is what makes the unsubscribe
 * link, the `List-Unsubscribe` headers, and the idempotency key per-person — the three
 * things a batched marketing engine would have to solve differently (see Phase 2).
 */

import { sendEmail } from '../email-service';
import { generateUnsubscribeToken } from '../notification-email-service';
import { listUnsubscribeHeaders, preflight, type PreflightResult } from './core';
import { buildBroadcastEmail, renderBroadcastEmail } from './content';
import type {
  BroadcastEngine,
  BroadcastEnginePreflightInput,
  BroadcastRecipientInput,
} from './engine';
import type { NotificationTypeValue } from '@pagespace/db/schema/notifications';

export interface TransactionalEngineConfig {
  /** The broadcast row's id — namespaces the idempotency key. */
  broadcastId: string;
  subject: string;
  bodyMarkdown: string;
  notificationType: NotificationTypeValue;
  /** Public app base URL the unsubscribe link is built from. */
  baseUrl: string;
  /** CAN-SPAM postal address for the footer. */
  postalAddress?: string;
}

/**
 * The per-recipient idempotency key.
 *
 * Stable across retries ON PURPOSE: that is what makes a retry after a lost response
 * collapse into the original send instead of delivering a second copy, within Resend's
 * idempotency window (~24h). Namespaced by broadcast so two campaigns to the same person
 * are two emails, not one. The `broadcast_recipients` ledger — not this key — is what
 * protects a retry days later.
 */
export function broadcastIdempotencyKey(broadcastId: string, userId: string): string {
  return `broadcast:${broadcastId}:${userId}`;
}

export function createTransactionalEngine(config: TransactionalEngineConfig): BroadcastEngine {
  const unsubscribeUrlFor = (token: string) =>
    `${config.baseUrl}/api/notifications/unsubscribe/${token}`;

  // renderOne's output carries the placeholder token, not a recipient's, so it is
  // byte-identical for every recipient — and a dry run calls it once per audience
  // row. Render once; a 50k-recipient preview should not pay 50k markdown-parse +
  // SSR passes to recompute one constant string. (Not reused across engines: the
  // cache lives and dies with this config closure.)
  let renderedPreview: Promise<string> | null = null;

  return {
    name: 'transactional',

    async preflight(input: BroadcastEnginePreflightInput): Promise<PreflightResult> {
      return preflight({
        live: input.live,
        // `config.baseUrl` — the one `unsubscribeUrlFor` actually builds links from. Taking
        // a base URL from the caller here would let preflight pass on one URL while the
        // send used another, mailing everyone an opt-out link the check never looked at.
        baseUrl: config.baseUrl,
        suppressed: input.suppressed,
        isOnPrem: input.isOnPrem,
        fromEmail: input.fromEmail,
      });
    },

    async sendOne(recipient: BroadcastRecipientInput): Promise<void> {
      const token = await generateUnsubscribeToken(recipient.userId, config.notificationType);
      const unsubscribeUrl = unsubscribeUrlFor(token);

      await sendEmail({
        to: recipient.email,
        subject: config.subject,
        // The same builder the dry-run preview renders, so what the admin approved and
        // what ships are the same email by construction.
        react: buildBroadcastEmail({
          subject: config.subject,
          bodyMarkdown: config.bodyMarkdown,
          unsubscribeUrl,
          postalAddress: config.postalAddress,
        }),
        // Bulk mail must offer a client-level one-click unsubscribe, not just a body
        // link. The unsubscribe route answers POST for exactly this.
        headers: listUnsubscribeHeaders(unsubscribeUrl),
        idempotencyKey: broadcastIdempotencyKey(config.broadcastId, recipient.userId),
      });
    },

    /** Dry-run: render the real email so a content error still surfaces, and send nothing. */
    renderOne(): Promise<string> {
      renderedPreview ??= renderBroadcastEmail({
        subject: config.subject,
        bodyMarkdown: config.bodyMarkdown,
        // A dry run mints no token: that would be a DB write per previewed recipient.
        unsubscribeUrl: unsubscribeUrlFor('<token>'),
        postalAddress: config.postalAddress,
      }).catch((error) => {
        // A failed render must not be cached: the next call should retry, not
        // replay a stale rejection after the operator fixes the content.
        renderedPreview = null;
        throw error;
      });
      return renderedPreview;
    },
  };
}
