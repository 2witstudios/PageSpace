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

type UnsubscribeOutcome =
  | { ok: true; userId: string; notificationType: NotificationType }
  | { ok: false; status: number; error: string };

/**
 * Consume a one-time unsubscribe token and record the opt-out.
 *
 * Shared by GET (the footer link a human clicks) and POST (RFC 8058 one-click,
 * which Gmail/Yahoo invoke from the `List-Unsubscribe-Post` header on bulk mail).
 * Both must have identical effect; only the response shape differs.
 */
async function applyUnsubscribe(token: string): Promise<UnsubscribeOutcome> {
  const tokenHash = hashToken(token);

  // Claim the token in ONE statement. A read-then-write leaves a window where two
  // concurrent hits (a mail client's one-click POST and the human clicking the
  // link) both see an unused token and both proceed. Gating the UPDATE on
  // `usedAt IS NULL` and taking the returned row means exactly one caller wins.
  const [record] = await db
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

  if (!record) {
    loggers.api.warn('Invalid or expired unsubscribe token attempted');
    return { ok: false, status: 400, error: 'Invalid or expired unsubscribe link' };
  }

  const userId = record.userId;
  const notificationType = record.notificationType as NotificationType;

  if (!userId || !notificationType) {
    return { ok: false, status: 400, error: 'Invalid unsubscribe token' };
  }

  if (!VALID_NOTIFICATION_TYPES.has(notificationType)) {
    loggers.api.warn('Invalid notification type in unsubscribe token', { notificationType });
    return { ok: false, status: 400, error: 'Invalid notification type' };
  }

  const existingPreference = await db.query.emailNotificationPreferences.findFirst({
    where: and(
      eq(emailNotificationPreferences.userId, userId),
      eq(emailNotificationPreferences.notificationType, notificationType)
    ),
  });

  if (existingPreference) {
    await db
      .update(emailNotificationPreferences)
      .set({ emailEnabled: false, updatedAt: new Date() })
      .where(and(
        eq(emailNotificationPreferences.userId, userId),
        eq(emailNotificationPreferences.notificationType, notificationType)
      ));
  } else {
    await db
      .insert(emailNotificationPreferences)
      .values({ userId, notificationType, emailEnabled: false });
  }

  audit({ eventType: 'data.write', userId, resourceType: 'notification_prefs', resourceId: 'self' });

  return { ok: true, userId, notificationType };
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
