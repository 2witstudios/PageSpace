import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { userToastNotificationPreferences } from '@pagespace/db/schema/toast-notification-preferences';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const TOAST_LEVELS = ['all', 'mentions', 'off'] as const;
type ToastLevel = (typeof TOAST_LEVELS)[number];

// GET /api/settings/toast-preferences - Get user's in-app toast notification level
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const preference = await db.query.userToastNotificationPreferences.findFirst({
      where: eq(userToastNotificationPreferences.userId, userId),
    });

    return NextResponse.json({ level: preference?.level ?? 'all' });
  } catch (error) {
    loggers.api.error('Error fetching toast notification preference:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch toast notification preference' },
      { status: 500 }
    );
  }
}

// PATCH /api/settings/toast-preferences - Update the in-app toast notification level
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { level } = body;

    if (!TOAST_LEVELS.includes(level)) {
      return NextResponse.json(
        { error: 'level must be one of: all, mentions, off' },
        { status: 400 }
      );
    }

    const existingPreference = await db.query.userToastNotificationPreferences.findFirst({
      where: eq(userToastNotificationPreferences.userId, userId),
    });

    if (existingPreference) {
      const [updated] = await db
        .update(userToastNotificationPreferences)
        .set({
          level: level as ToastLevel,
          updatedAt: new Date(),
        })
        .where(eq(userToastNotificationPreferences.userId, userId))
        .returning();

      audit({ eventType: 'admin.settings.changed', userId, resourceType: 'toast_notification_preference' });
      return NextResponse.json({ preference: updated });
    } else {
      const [created] = await db
        .insert(userToastNotificationPreferences)
        .values({
          userId,
          level: level as ToastLevel,
        })
        .returning();

      audit({ eventType: 'admin.settings.changed', userId, resourceType: 'toast_notification_preference' });
      return NextResponse.json({ preference: created });
    }
  } catch (error) {
    loggers.api.error('Error updating toast notification preference:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update toast notification preference' },
      { status: 500 }
    );
  }
}
