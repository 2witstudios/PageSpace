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
