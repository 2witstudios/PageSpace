import { NextResponse } from 'next/server';
import { db, emailNotificationPreferences, eq, and } from '@pagespace/db';
import { jwtVerify } from 'jose';
import { loggers } from '@pagespace/lib/server';

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
  | 'NEW_DIRECT_MESSAGE';

// GET /api/notifications/unsubscribe/[token] - Unsubscribe from email notifications
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;

    // Verify the JWT token
    const secret = new TextEncoder().encode(
      process.env.JWT_SECRET || 'your_jwt_secret_here'
    );

    let payload;
    try {
      const verified = await jwtVerify(token, secret);
      payload = verified.payload;
    } catch (error) {
      loggers.api.error('Invalid unsubscribe token:', error as Error);
      return NextResponse.json(
        { error: 'Invalid or expired unsubscribe link' },
        { status: 400 }
      );
    }

    const userId = payload.userId as string;
    const notificationType = payload.notificationType as NotificationType;

    if (!userId || !notificationType) {
      return NextResponse.json(
        { error: 'Invalid unsubscribe token' },
        { status: 400 }
      );
    }

    // Check if preference already exists
    const existingPreference = await db.query.emailNotificationPreferences.findFirst({
      where: and(
        eq(emailNotificationPreferences.userId, userId),
        eq(emailNotificationPreferences.notificationType, notificationType)
      ),
    });

    if (existingPreference) {
      // Update existing preference to disable
      await db
        .update(emailNotificationPreferences)
        .set({
          emailEnabled: false,
          updatedAt: new Date(),
        })
        .where(and(
          eq(emailNotificationPreferences.userId, userId),
          eq(emailNotificationPreferences.notificationType, notificationType)
        ));
    } else {
      // Create new preference with emailEnabled = false
      await db
        .insert(emailNotificationPreferences)
        .values({
          userId,
          notificationType,
          emailEnabled: false,
        });
    }

    // Redirect to a confirmation page
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    return NextResponse.redirect(
      `${appUrl}/unsubscribe-success?type=${notificationType}`
    );
  } catch (error) {
    loggers.api.error('Error processing unsubscribe:', error as Error);
    return NextResponse.json(
      { error: 'Failed to process unsubscribe request' },
      { status: 500 }
    );
  }
}
