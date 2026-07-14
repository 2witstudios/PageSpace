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

interface SuppressionPage {
  data?: Array<{ id?: string; email?: string; unsubscribed?: boolean }>;
  has_more?: boolean;
}

const fail = (why: string): never => {
  throw new Error(`Failed to read Resend suppression audience: ${why}`);
};

/**
 * Read back the suppression audience: every contact flagged `unsubscribed`.
 *
 * The write side ({@link createResendSuppressionClient}) is best-effort because
 * erasure must not hinge on Resend's uptime. The read side is the opposite — it
 * exists so a bulk sender can EXCLUDE erased addresses. The failure that matters
 * here is not an error (an error is loud); it is a SHORT LIST, which looks
 * exactly like a complete one and quietly mails everybody it left out. So this
 * returns only a set it can PROVE is complete, and throws otherwise.
 *
 * Two things are deliberate:
 *
 *  - It calls `/audiences/{id}/contacts` directly rather than `contacts.list()`.
 *    In resend@6, `contacts.list({ audienceId })` rewrites the request to
 *    `/segments/{id}/contacts`, while the suppression WRITES here go to
 *    `/audiences/{id}/contacts` — i.e. the SDK would have us ask a different
 *    resource about the id we wrote to. Read and write must address the same one.
 *  - Completeness is proven, not assumed: we page while `has_more` is true, and
 *    if the API omits `has_more` entirely we only accept the result when the page
 *    came back SHORT (fewer rows than we asked for). A full page with no
 *    `has_more` is ambiguous — it may or may not have been truncated — so we
 *    refuse rather than guess.
 *
 * Returns normalized (trimmed, lowercased) addresses, or `null` when no audience
 * is configured (the caller decides: a broadcast refuses to send, a dry run may
 * proceed).
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
    const query = new URLSearchParams({ limit: String(SUPPRESSION_PAGE_SIZE) });
    if (after) query.set('after', after);

    const { data, error } = await resend.get<SuppressionPage>(
      `/audiences/${audienceId}/contacts?${query.toString()}`,
    );

    if (error) fail(error.message);
    if (!data) fail('empty response');

    const contacts = data!.data;
    if (!Array.isArray(contacts)) {
      fail('response did not carry a contact array');
    }

    for (const contact of contacts!) {
      if (contact.unsubscribed && contact.email) {
        suppressed.add(contact.email.trim().toLowerCase());
      }
    }

    const hasMore = data!.has_more;
    if (hasMore === false) return suppressed;

    if (hasMore !== true) {
      // No pagination signal. Only safe to stop if the page was SHORT — a full
      // page might have been cut off, and we must never return a maybe-truncated
      // suppression list.
      if (contacts!.length < SUPPRESSION_PAGE_SIZE) return suppressed;
      fail(
        'a full page came back with no `has_more` flag, so the list may be truncated. ' +
          'Refusing to return a possibly-incomplete suppression list.',
      );
    }

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
