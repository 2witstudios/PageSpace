/**
 * Concrete Resend-backed implementation of {@link EmailSuppressionClient}.
 *
 * Resend manages suppression through audience contacts flagged
 * `unsubscribed: true`. We upsert the erased address into the configured
 * audience as unsubscribed so the provider stops delivering to it. If no
 * audience is configured the client is a logged no-op (the pure plan still
 * records intent on the DSR row).
 */

import { Resend } from 'resend';
import { loggers } from '../../logging/logger-config';
import type { EmailSuppressionClient, EmailSuppressionEntry } from './email-suppression';

/**
 * Read back the suppression audience: every contact flagged `unsubscribed`.
 *
 * The write side ({@link createResendSuppressionClient}) is best-effort because
 * erasure must not hinge on Resend's uptime. The read side is the opposite —
 * it exists so a bulk sender can EXCLUDE erased/opted-out addresses, so a
 * failure here must never be swallowed into an empty set (that would silently
 * mail everyone we were told not to mail). Errors throw; an unconfigured
 * audience returns `null` so the caller can decide (a broadcast should refuse
 * to send live, a dry run may proceed).
 *
 * Returns normalized (trimmed, lowercased) addresses.
 */
export async function listSuppressedEmails(): Promise<Set<string> | null> {
  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  if (!apiKey || !audienceId) {
    loggers.auth.warn(
      'Resend suppression list unavailable: RESEND_API_KEY or RESEND_AUDIENCE_ID not configured'
    );
    return null;
  }

  const resend = new Resend(apiKey);
  const { data, error } = await resend.contacts.list({ audienceId });

  if (error) {
    throw new Error(`Failed to read Resend suppression audience: ${error.message}`);
  }

  const suppressed = new Set<string>();
  for (const contact of data?.data ?? []) {
    if (contact.unsubscribed && contact.email) {
      suppressed.add(contact.email.trim().toLowerCase());
    }
  }
  return suppressed;
}

export function createResendSuppressionClient(): EmailSuppressionClient {
  return {
    suppress: async (entry: EmailSuppressionEntry): Promise<void> => {
      const apiKey = process.env.RESEND_API_KEY;
      const audienceId = process.env.RESEND_AUDIENCE_ID;

      if (!apiKey || !audienceId) {
        loggers.auth.warn(
          'Resend suppression skipped: RESEND_API_KEY or RESEND_AUDIENCE_ID not configured',
          { userId: entry.userId }
        );
        return;
      }

      const resend = new Resend(apiKey);

      // Upsert as unsubscribed. update() targets an existing contact by email;
      // if it does not exist yet, create() it already suppressed.
      const updated = await resend.contacts.update({
        audienceId,
        email: entry.email,
        unsubscribed: true,
      });

      if (updated.error) {
        await resend.contacts.create({
          audienceId,
          email: entry.email,
          unsubscribed: true,
        });
      }
    },
  };
}
