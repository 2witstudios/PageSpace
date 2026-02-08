import { NextResponse } from 'next/server';
import { db, displayPreferences, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const DISPLAY_PREFERENCE_TYPES = [
  'SHOW_TOKEN_COUNTS',
  'SHOW_CODE_TOGGLE',
] as const;

type DisplayPreferenceType = typeof DISPLAY_PREFERENCE_TYPES[number];

// GET /api/settings/display-preferences - Get user's display preferences
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const preferences = await db
      .select()
      .from(displayPreferences)
      .where(eq(displayPreferences.userId, userId));

    const preferenceMap = new Map(
      preferences.map((pref) => [pref.preferenceType, pref.enabled])
    );

    // Build response with camelCase keys, default to false if not set
    const response = {
      showTokenCounts: preferenceMap.get('SHOW_TOKEN_COUNTS') ?? false,
      showCodeToggle: preferenceMap.get('SHOW_CODE_TOGGLE') ?? false,
    };

    return NextResponse.json(response);
  } catch (error) {
    loggers.api.error('Error fetching display preferences:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch display preferences' },
      { status: 500 }
    );
  }
}

// PATCH /api/settings/display-preferences - Update a display preference
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { preferenceType, enabled } = body;

    if (!preferenceType || typeof enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'preferenceType and enabled are required' },
        { status: 400 }
      );
    }

    if (!DISPLAY_PREFERENCE_TYPES.includes(preferenceType as DisplayPreferenceType)) {
      return NextResponse.json(
        { error: 'Invalid preference type' },
        { status: 400 }
      );
    }

    const existingPreference = await db.query.displayPreferences.findFirst({
      where: and(
        eq(displayPreferences.userId, userId),
        eq(displayPreferences.preferenceType, preferenceType)
      ),
    });

    if (existingPreference) {
      const [updated] = await db
        .update(displayPreferences)
        .set({
          enabled,
          updatedAt: new Date(),
        })
        .where(and(
          eq(displayPreferences.userId, userId),
          eq(displayPreferences.preferenceType, preferenceType)
        ))
        .returning();

      return NextResponse.json({ preference: updated });
    } else {
      const [created] = await db
        .insert(displayPreferences)
        .values({
          userId,
          preferenceType,
          enabled,
        })
        .returning();

      return NextResponse.json({ preference: created });
    }
  } catch (error) {
    loggers.api.error('Error updating display preference:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update display preference' },
      { status: 500 }
    );
  }
}
