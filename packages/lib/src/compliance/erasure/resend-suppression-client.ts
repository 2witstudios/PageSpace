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

/** Requested page size. Resend's documented maximum; its default is only 20. */
const SUPPRESSION_PAGE_SIZE = 100;

/** Backstop against an API that never stops saying there's another page. */
const MAX_SUPPRESSION_PAGES = 1000;

const fail = (why: string): never => {
  throw new Error(`Failed to read Resend suppression audience: ${why}`);
};

/**
 * Read back the suppression audience: every contact flagged `unsubscribed`.
 *
 * The write side ({@link createResendSuppressionClient}) is best-effort because
 * erasure must not hinge on Resend's uptime. The read side is the opposite — it
 * exists so a bulk sender can EXCLUDE erased addresses. The failure that matters
 * here is not an error (an error is loud); it is a SHORT LIST, which looks exactly
 * like a complete one and quietly mails everybody it left out. So this returns
 * only a set it can PROVE is complete, and throws otherwise:
 *
 *  - the list is paginated (Resend serves at most 100 contacts per call, and only
 *    20 unless you ask), so it pages via the `after` cursor until `has_more` is
 *    false;
 *  - `has_more` MUST be present. Absent is not "no more pages" — it is an
 *    unrecognized response, and guessing there is why an audience gets truncated.
 *
 * (`resend.contacts.list` addresses the same underlying resource the suppression
 * writes do: in resend@6, `audiences` is an alias of `segments` and the audience
 * id IS the segment id.)
 *
 * Returns normalized (trimmed, lowercased) addresses, or `null` when no audience
 * is configured — the caller decides what that means (a broadcast refuses to send
 * live; a dry run may proceed).
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

  let after: string | undefined;
  for (let page = 0; page < MAX_SUPPRESSION_PAGES; page++) {
    const { data, error } = await resend.contacts.list({
      audienceId,
      limit: SUPPRESSION_PAGE_SIZE,
      ...(after ? { after } : {}),
    });

    if (error) fail(error.message);
    if (!data) fail('empty response');

    const contacts = data!.data;
    if (!Array.isArray(contacts)) fail('response did not carry a contact array');

    for (const contact of contacts!) {
      if (contact.unsubscribed && contact.email) {
        suppressed.add(contact.email.trim().toLowerCase());
      }
    }

    const hasMore = data!.has_more;
    if (typeof hasMore !== 'boolean') {
      fail(
        'the response carried no `has_more` flag, so we cannot tell whether the list is ' +
          'complete. Refusing to return a possibly-truncated suppression list.',
      );
    }
    if (!hasMore) return suppressed;

    const last = contacts![contacts!.length - 1];
    if (!last?.id) {
      fail('`has_more` was set but the page carried no cursor to continue from');
    }
    after = last!.id;
  }

  return fail(
    `exceeded ${MAX_SUPPRESSION_PAGES} pages (${suppressed.size} suppressed so far). ` +
      'Refusing to return a possibly-truncated list.',
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
