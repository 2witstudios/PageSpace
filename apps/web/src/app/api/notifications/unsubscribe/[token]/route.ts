import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, gt, isNull, isNotNull } from '@pagespace/db/operators'
import { emailUnsubscribeTokens } from '@pagespace/db/schema/auth'
import { emailNotificationPreferences } from '@pagespace/db/schema/email-notifications';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';

type NotificationType =
  | 'PERMISSION_GRANTED'
  | 'PERMISSION_REVOKED'
  | 'PERMISSION_UPDATED'
  | 'PAGE_SHARED'
  | 'DRIVE_INVITED'
  | 'DRIVE_JOINED'
  | 'DRIVE_ROLE_CHANGED'
  | 'CONNECTION_REQUEST'
  | 'CONNECTION_ACCEPTED'
  | 'CONNECTION_REJECTED'
  | 'NEW_DIRECT_MESSAGE'
  | 'PRODUCT_UPDATE';

const VALID_NOTIFICATION_TYPES = new Set<string>([
  'PERMISSION_GRANTED',
  'PERMISSION_REVOKED',
  'PERMISSION_UPDATED',
  'PAGE_SHARED',
  'DRIVE_INVITED',
  'DRIVE_JOINED',
  'DRIVE_ROLE_CHANGED',
  'CONNECTION_REQUEST',
  'CONNECTION_ACCEPTED',
  'CONNECTION_REJECTED',
  'NEW_DIRECT_MESSAGE',
  'PRODUCT_UPDATE',
]);

type UnsubscribeFailure = { ok: false; status: number; error: string };
type UnsubscribeOutcome =
  | { ok: true; userId: string; notificationType: NotificationType }
  | UnsubscribeFailure;

/**
 * Thrown inside the transaction to roll the token claim back on a non-success.
 * Once the gated UPDATE has stamped `usedAt`, returning an error would COMMIT
 * that consumption while writing no opt-out — the token is then spent forever
 * and a retry can never apply it. Throwing instead aborts the transaction, so
 * the claim is undone and the same token can be presented again.
 */
class UnsubscribeAbort extends Error {
  constructor(readonly outcome: UnsubscribeFailure) {
    super(outcome.error);
    this.name = 'UnsubscribeAbort';
  }
}

/**
 * Consume a one-time unsubscribe token and record the opt-out.
 *
 * Shared by GET (the footer link a human clicks) and POST (RFC 8058 one-click,
 * which Gmail/Yahoo invoke from the `List-Unsubscribe-Post` header on bulk mail).
 * Both must have identical effect; only the response shape differs.
 *
 * The token claim and the preference write happen in ONE transaction: a
 * transient failure on the preference write (or any error after the claim) rolls
 * the claim back, so we never end up with a spent token and no opt-out — which
 * would strand the recipient subscribed while the GET path reports success.
 */
async function applyUnsubscribe(token: string): Promise<UnsubscribeOutcome> {
  const tokenHash = hashToken(token);

  let result: UnsubscribeOutcome;
  try {
    result = await db.transaction(async (tx): Promise<UnsubscribeOutcome> => {
      // Claim the token in ONE statement. A read-then-write leaves a window where
      // two concurrent hits (a mail client's one-click POST and the human
      // clicking the link) both see an unused token and both proceed. Gating the
      // UPDATE on `usedAt IS NULL` and taking the returned row means exactly one
      // caller wins.
      const [record] = await tx
        .update(emailUnsubscribeTokens)
        .set({ usedAt: new Date() })
        .where(and(
          eq(emailUnsubscribeTokens.tokenHash, tokenHash),
          gt(emailUnsubscribeTokens.expiresAt, new Date()),
          isNull(emailUnsubscribeTokens.usedAt)
        ))
        .returning({
          userId: emailUnsubscribeTokens.userId,
          notificationType: emailUnsubscribeTokens.notificationType,
        });

      // Nothing matched: 0 rows were written, so committing this empty
      // transaction consumes nothing. (Already-used / expired / unknown token.)
      if (!record) {
        loggers.api.warn('Invalid or expired unsubscribe token attempted');
        return { ok: false, status: 400, error: 'Invalid or expired unsubscribe link' };
      }

      const userId = record.userId;
      const notificationType = record.notificationType as NotificationType;

      // From here the token IS claimed; any non-success must roll it back.
      if (!userId || !notificationType) {
        throw new UnsubscribeAbort({ ok: false, status: 400, error: 'Invalid unsubscribe token' });
      }

      if (!VALID_NOTIFICATION_TYPES.has(notificationType)) {
        loggers.api.warn('Invalid notification type in unsubscribe token', { notificationType });
        throw new UnsubscribeAbort({ ok: false, status: 400, error: 'Invalid notification type' });
      }

      const existingPreference = await tx.query.emailNotificationPreferences.findFirst({
        where: and(
          eq(emailNotificationPreferences.userId, userId),
          eq(emailNotificationPreferences.notificationType, notificationType)
        ),
      });

      if (existingPreference) {
        await tx
          .update(emailNotificationPreferences)
          .set({ emailEnabled: false, updatedAt: new Date() })
          .where(and(
            eq(emailNotificationPreferences.userId, userId),
            eq(emailNotificationPreferences.notificationType, notificationType)
          ));
      } else {
        await tx
          .insert(emailNotificationPreferences)
          .values({ userId, notificationType, emailEnabled: false });
      }

      return { ok: true, userId, notificationType };
    });
  } catch (error) {
    // A deliberate abort carries its own 400; anything else (a transient DB
    // error) rolled the claim back and must surface so the caller returns 500
    // and the recipient can retry with the same token.
    if (error instanceof UnsubscribeAbort) return error.outcome;
    throw error;
  }

  // Audit only a committed opt-out.
  if (result.ok) {
    audit({ eventType: 'data.write', userId: result.userId, resourceType: 'notification_prefs', resourceId: 'self' });
  }

  return result;
}

/**
 * POST /api/notifications/unsubscribe/[token] — the actual opt-out.
 *
 * This is the ONLY method that mutates. Two callers reach it: a mail client
 * invoking RFC 8058 one-click from the `List-Unsubscribe-Post` header (which
 * never renders our page, hence the bare 200), and the confirm button on
 * /unsubscribe. Unauthenticated by design — possession of the one-time token IS
 * the authorization, and the RFC requires the POST to work without a session.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;
    const result = await applyUnsubscribe(token);

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(
      { unsubscribed: true, notificationType: result.notificationType },
      { status: 200 }
    );
  } catch (error) {
    loggers.api.error('Error processing one-click unsubscribe:', error as Error);
    return NextResponse.json(
      { error: 'Failed to process unsubscribe request' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/notifications/unsubscribe/[token] — validate only, then hand off.
 *
 * Deliberately does NOT unsubscribe. Spam filters, link scanners and corporate
 * mail gateways fetch the URLs they find in a message (both in the body and in
 * the `List-Unsubscribe` header), so a mutating GET means a machine can opt a
 * user out of email they never asked to leave — and they would never know. The
 * token is left unconsumed and the user is sent to a page whose button POSTs.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;

    const appUrlForToken =
      process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;

    // Read-only: confirm the token is live so an expired link fails here rather
    // than after the user has clicked a confirm button.
    const record = await db.query.emailUnsubscribeTokens.findFirst({
      where: and(
        eq(emailUnsubscribeTokens.tokenHash, hashToken(token)),
        gt(emailUnsubscribeTokens.expiresAt, new Date()),
        isNull(emailUnsubscribeTokens.usedAt)
      ),
    });

    if (!record) {
      // An already-USED token is the normal aftermath of a mail client's one-click
      // POST: the reader then also clicks the footer link, and would otherwise be
      // shown a raw JSON error for an unsubscribe that in fact succeeded. Tell
      // them the truth — they are unsubscribed — rather than an error.
      const used = await db.query.emailUnsubscribeTokens.findFirst({
        where: and(
          eq(emailUnsubscribeTokens.tokenHash, hashToken(token)),
          isNotNull(emailUnsubscribeTokens.usedAt)
        ),
      });

      if (used && VALID_NOTIFICATION_TYPES.has(used.notificationType)) {
        const done = new URL('/unsubscribe-success', appUrlForToken);
        done.searchParams.set('type', used.notificationType);
        return NextResponse.redirect(done.toString());
      }

      loggers.api.warn('Invalid or expired unsubscribe token attempted');
      return NextResponse.json(
        { error: 'Invalid or expired unsubscribe link' },
        { status: 400 }
      );
    }

    const notificationType = record.notificationType;
    if (!VALID_NOTIFICATION_TYPES.has(notificationType)) {
      loggers.api.warn('Invalid notification type in unsubscribe token', { notificationType });
      return NextResponse.json({ error: 'Invalid notification type' }, { status: 400 });
    }

    // Construct and validate redirect URL to prevent open redirect
    const appUrl = appUrlForToken;
    const redirectUrl = new URL('/unsubscribe', appUrl);
    redirectUrl.searchParams.set('token', token);
    redirectUrl.searchParams.set('type', notificationType);

    // Ensure redirect stays within the application domain
    const appOrigin = new URL(appUrl).origin;
    if (redirectUrl.origin !== appOrigin) {
      loggers.api.error('Redirect URL origin mismatch detected', {
        expected: appOrigin,
        actual: redirectUrl.origin,
      });
      return NextResponse.json(
        { error: 'Invalid redirect configuration' },
        { status: 500 }
      );
    }

    return NextResponse.redirect(redirectUrl.toString());
  } catch (error) {
    loggers.api.error('Error processing unsubscribe:', error as Error);
    return NextResponse.json(
      { error: 'Failed to process unsubscribe request' },
      { status: 500 }
    );
  }
}
