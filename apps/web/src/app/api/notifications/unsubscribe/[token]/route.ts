import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, gt, isNull } from '@pagespace/db/operators'
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
  const record = await db.query.emailUnsubscribeTokens.findFirst({
    where: and(
      eq(emailUnsubscribeTokens.tokenHash, tokenHash),
      gt(emailUnsubscribeTokens.expiresAt, new Date()),
      isNull(emailUnsubscribeTokens.usedAt)
    ),
  });

  if (!record) {
    loggers.api.warn('Invalid or expired unsubscribe token attempted');
    return { ok: false, status: 400, error: 'Invalid or expired unsubscribe link' };
  }

  // Mark token as used (one-time use)
  await db.update(emailUnsubscribeTokens)
    .set({ usedAt: new Date() })
    .where(eq(emailUnsubscribeTokens.tokenHash, tokenHash));

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
 * POST /api/notifications/unsubscribe/[token] — RFC 8058 one-click unsubscribe.
 *
 * Mail clients POST here directly from the `List-Unsubscribe` header without ever
 * showing the user our page, so this returns a bare 200 rather than a redirect.
 * Bulk mail advertising `List-Unsubscribe-Post` MUST answer POST, or the client's
 * unsubscribe button fails and the sender's reputation takes the hit.
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
    return NextResponse.json({ unsubscribed: true }, { status: 200 });
  } catch (error) {
    loggers.api.error('Error processing one-click unsubscribe:', error as Error);
    return NextResponse.json(
      { error: 'Failed to process unsubscribe request' },
      { status: 500 }
    );
  }
}

// GET /api/notifications/unsubscribe/[token] - Unsubscribe from email notifications
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;
    const result = await applyUnsubscribe(token);

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    const { notificationType } = result;

    // Redirect to a confirmation page
    const appUrl = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;

    // Construct and validate redirect URL to prevent open redirect
    const redirectUrl = new URL('/unsubscribe-success', appUrl);
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
