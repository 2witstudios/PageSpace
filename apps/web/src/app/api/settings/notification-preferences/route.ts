import { NextResponse } from 'next/server';
import { db, emailNotificationPreferences, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

// All available notification types
const NOTIFICATION_TYPES = [
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
] as const;

// GET /api/settings/notification-preferences - Get user's email notification preferences
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get all preferences for this user
    const preferences = await db
      .select()
      .from(emailNotificationPreferences)
      .where(eq(emailNotificationPreferences.userId, userId));

    // Create a map of existing preferences
    const preferenceMap = new Map(
      preferences.map((pref) => [pref.notificationType, pref.emailEnabled])
    );

    // Build complete preference list (default to true if not set)
    const completePreferences = NOTIFICATION_TYPES.map((type) => ({
      notificationType: type,
      emailEnabled: preferenceMap.get(type) ?? true,
    }));

    return NextResponse.json({ preferences: completePreferences });
  } catch (error) {
    loggers.api.error('Error fetching notification preferences:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch notification preferences' },
      { status: 500 }
    );
  }
}

// PATCH /api/settings/notification-preferences - Update email notification preferences
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { notificationType: type, emailEnabled } = body;

    if (!type || typeof emailEnabled !== 'boolean') {
      return NextResponse.json(
        { error: 'notificationType and emailEnabled are required' },
        { status: 400 }
      );
    }

    // Validate notification type
    if (!NOTIFICATION_TYPES.includes(type)) {
      return NextResponse.json(
        { error: 'Invalid notification type' },
        { status: 400 }
      );
    }

    // Check if preference exists
    const existingPreference = await db.query.emailNotificationPreferences.findFirst({
      where: and(
        eq(emailNotificationPreferences.userId, userId),
        eq(emailNotificationPreferences.notificationType, type)
      ),
    });

    if (existingPreference) {
      // Update existing preference
      const [updated] = await db
        .update(emailNotificationPreferences)
        .set({
          emailEnabled,
          updatedAt: new Date(),
        })
        .where(and(
          eq(emailNotificationPreferences.userId, userId),
          eq(emailNotificationPreferences.notificationType, type)
        ))
        .returning();

      return NextResponse.json({ preference: updated });
    } else {
      // Create new preference
      const [created] = await db
        .insert(emailNotificationPreferences)
        .values({
          userId,
          notificationType: type,
          emailEnabled,
        })
        .returning();

      return NextResponse.json({ preference: created });
    }
  } catch (error) {
    loggers.api.error('Error updating notification preferences:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update notification preferences' },
      { status: 500 }
    );
  }
}
