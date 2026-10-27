/**
 * Who a broadcast is allowed to reach.
 *
 * Two kinds of rule live here, and the difference is the whole point of the module:
 *
 *  - **Standard exclusions** are applied in CODE, on every resolve, and are not
 *    representable in `BroadcastAudienceDefinition`. A suspended account and an
 *    unverified address are properties of the account, not of the campaign, so no
 *    stored definition — and no admin editing JSON — can turn them off. The opt-out
 *    and GDPR sets are returned separately and applied per-row by `decideRecipient`,
 *    because a skip must be COUNTED and recorded, not silently filtered away.
 *  - **Targeting filters** (plan tier, signup window, hand-picked ids) are the
 *    operator's, and live in the stored definition.
 *
 * Rows come back ENCRYPTED: `users.email`/`users.name` are AES-256-GCM ciphertext at
 * rest (GDPR #965). Decryption is the caller's job (`decryptUserRow`), so PII is only
 * ever in memory for the row being addressed and never widens past the send loop.
 */

import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { emailNotificationPreferences } from '@pagespace/db/schema/email-notifications';
import { dataSubjectRequests } from '@pagespace/db/schema/data-subject-requests';
import type { BroadcastAudienceDefinition } from '@pagespace/db/schema/email-broadcasts';
import { and, count, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, asc, type SQL } from '@pagespace/db/operators';
// The EMAIL-side notification type (includes PRODUCT_UPDATE), not the in-app
// `Notification` union — a broadcast channel is never raised as an in-app notification.
import type { NotificationTypeValue } from '@pagespace/db/schema/notifications';

/** One audience row, exactly as stored: `name`/`email` are still ciphertext. */
export interface EncryptedAudienceRow {
  id: string;
  name: string | null;
  email: string | null;
}

/** Page of a keyset walk over the audience. */
export interface AudiencePage {
  rows: EncryptedAudienceRow[];
  /** Pass as `after` to get the next page; null when the audience is exhausted. */
  nextCursor: string | null;
}

/**
 * The predicates that define an audience.
 *
 * `includeUnverified` is the ONLY standard exclusion an operator can lift, and it is
 * opt-in per broadcast: an unverified address was never proven to belong to the account
 * holder, so a blast to it may be mail to a stranger (or a spam trap that damages the
 * sending domain). Suspension is never liftable.
 */
function audienceFilters(def: BroadcastAudienceDefinition): SQL[] {
  const filters: SQL[] = [
    // Standard exclusions — always, regardless of what the definition says.
    isNull(users.suspendedAt),
  ];

  if (!def.includeUnverified) {
    filters.push(isNotNull(users.emailVerified));
  }

  // Operator targeting. An empty array is treated as "no filter" rather than "match
  // nothing": an empty multi-select in the UI means the admin picked nothing, not that
  // they intend a zero-recipient send.
  if (def.planTiers?.length) {
    filters.push(inArray(users.subscriptionTier, def.planTiers));
  }

  if (def.signupAfter) {
    filters.push(gte(users.createdAt, new Date(def.signupAfter)));
  }

  if (def.signupBefore) {
    filters.push(lte(users.createdAt, new Date(def.signupBefore)));
  }

  // Hand-picked recipients still pass through every other filter above — picking a user
  // by hand is not a way to mail a suspended account.
  if (def.userIds?.length) {
    filters.push(inArray(users.id, def.userIds));
  }

  return filters;
}

/**
 * Resolve the audience for a definition.
 *
 * Keyset-paginated (`WHERE id > cursor ORDER BY id`) rather than all-at-once: the
 * audience is every user we have, and a worker that materializes all of them holds every
 * address in memory at once. An offset walk would also skip or repeat rows as the table
 * changes mid-send; the id keyset is stable.
 *
 * @param after - exclusive cursor; omit for the first page.
 */
export async function resolveAudience(
  def: BroadcastAudienceDefinition,
  opts: { limit?: number; after?: string | null } = {},
): Promise<AudiencePage> {
  const limit = opts.limit ?? 500;
  const filters = audienceFilters(def);
  if (opts.after) filters.push(gt(users.id, opts.after));

  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(...filters))
    .orderBy(asc(users.id))
    .limit(limit);

  // A short page means the audience is exhausted; a full page may or may not be, so the
  // caller asks again and gets an empty page. One wasted query beats dropping the tail.
  return {
    rows,
    nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
  };
}

/**
 * Count the audience without materializing it — the number the dry-run preview shows,
 * and the one an admin types to confirm a live send.
 *
 * This is the RAW targeting count: it does not subtract opted-out or rights-restricted
 * users, because those are per-row decisions the send loop counts as skips. It is an
 * upper bound on what will actually be mailed, and is deliberately the same query the
 * send walks.
 */
export async function countAudience(def: BroadcastAudienceDefinition): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(users)
    .where(and(...audienceFilters(def)));
  return row?.value ?? 0;
}

/** userIds that have explicitly turned this notification channel's email off. */
export async function loadOptedOutUserIds(type: NotificationTypeValue): Promise<Set<string>> {
  const rows = await db
    .select({ userId: emailNotificationPreferences.userId })
    .from(emailNotificationPreferences)
    .where(
      and(
        eq(emailNotificationPreferences.notificationType, type),
        eq(emailNotificationPreferences.emailEnabled, false),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

/**
 * userIds we are forbidden to market to because of a GDPR rights request.
 *
 * The Resend suppression audience only holds erasures that already EXECUTED.
 * An erasure that is still pending, queued, in progress, blocked (e.g. on
 * sole-owner drive disposition) or failed leaves a completely normal-looking row
 * in `users` — verified, unsuspended, absent from the audience. Mailing that
 * person a marketing blast is precisely the harm they asked us to prevent, and
 * it cannot be undone.
 *
 * Objections (Art 21) and restrictions (Art 18) are excluded even when
 * COMPLETED: honouring an objection to direct marketing is what makes it
 * completed. Only a cancelled request releases us.
 */
export async function loadRightsRestrictedUserIds(): Promise<Set<string>> {
  const rows = await db
    .select({ userId: dataSubjectRequests.userId })
    .from(dataSubjectRequests)
    .where(
      or(
        and(
          eq(dataSubjectRequests.requestType, 'erasure'),
          inArray(dataSubjectRequests.status, ['pending', 'queued', 'in_progress', 'blocked', 'failed']),
        ),
        and(
          inArray(dataSubjectRequests.requestType, ['objection', 'restriction']),
          ne(dataSubjectRequests.status, 'cancelled'),
        ),
      ),
    );

  return new Set(rows.map((r) => r.userId).filter((id): id is string => id !== null));
}