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

/** Resend's per-page maximum for contacts.list (the API default is only 20). */
const SUPPRESSION_PAGE_SIZE = 100;

/** Backstop against an API that never stops setting `has_more` (100k contacts). */
const MAX_SUPPRESSION_PAGES = 1000;

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
  const suppressed = new Set<string>();

  // Resend paginates contacts (max 100/page, and only 20 by default). A single
  // unpaginated call would hand back a partial audience that is INDISTINGUISHABLE
  // from a complete one — the caller would exclude the first page of erased users
  // and mail everyone after it. Page until `has_more` is false.
  let after: string | undefined;
  for (let page = 0; page < MAX_SUPPRESSION_PAGES; page++) {
    const { data, error } = await resend.contacts.list({
      audienceId,
      limit: SUPPRESSION_PAGE_SIZE,
      ...(after ? { after } : {}),
    });

    if (error) {
      throw new Error(`Failed to read Resend suppression audience: ${error.message}`);
    }
    if (!data) {
      throw new Error('Failed to read Resend suppression audience: empty response');
    }

    for (const contact of data.data) {
      if (contact.unsubscribed && contact.email) {
        suppressed.add(contact.email.trim().toLowerCase());
      }
    }

    if (!data.has_more) return suppressed;

    const last = data.data[data.data.length - 1];
    if (!last?.id) {
      // has_more with nothing to page from: we cannot advance the cursor, and
      // returning what we have would understate the suppression list. Refuse.
      throw new Error(
        'Failed to read Resend suppression audience: has_more was set but the page carried no cursor',
      );
    }
    after = last.id;
  }

  // A suppression list this large is more likely a paging bug than reality, and
  // silently returning a truncated set is the one outcome we must never produce.
  throw new Error(
    `Failed to read Resend suppression audience: exceeded ${MAX_SUPPRESSION_PAGES} pages ` +
      `(${suppressed.size} suppressed so far). Refusing to return a possibly-truncated list.`,
  );
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
