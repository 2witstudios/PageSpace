import { NextResponse } from 'next/server';
import { db, userHotkeyPreferences, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { getHotkeyDefinition } from '@/lib/hotkeys/registry';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

// GET /api/settings/hotkey-preferences - Get user's hotkey preferences
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const preferences = await db
      .select({
        hotkeyId: userHotkeyPreferences.hotkeyId,
        binding: userHotkeyPreferences.binding,
      })
      .from(userHotkeyPreferences)
      .where(eq(userHotkeyPreferences.userId, userId));

    return NextResponse.json({ preferences });
  } catch (error) {
    loggers.api.error('Error fetching hotkey preferences:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch hotkey preferences' },
      { status: 500 }
    );
  }
}

// PATCH /api/settings/hotkey-preferences - Update a hotkey preference
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { hotkeyId, binding } = body;

    if (!hotkeyId || typeof binding !== 'string') {
      return NextResponse.json(
        { error: 'hotkeyId and binding are required' },
        { status: 400 }
      );
    }

    // Validate hotkey exists in registry
    const definition = getHotkeyDefinition(hotkeyId);
    if (!definition) {
      return NextResponse.json(
        { error: 'Invalid hotkeyId' },
        { status: 400 }
      );
    }

    // Check if preference exists
    const existingPreference = await db.query.userHotkeyPreferences.findFirst({
      where: and(
        eq(userHotkeyPreferences.userId, userId),
        eq(userHotkeyPreferences.hotkeyId, hotkeyId)
      ),
    });

    if (existingPreference) {
      const [updated] = await db
        .update(userHotkeyPreferences)
        .set({
          binding,
          updatedAt: new Date(),
        })
        .where(and(
          eq(userHotkeyPreferences.userId, userId),
          eq(userHotkeyPreferences.hotkeyId, hotkeyId)
        ))
        .returning();

      return NextResponse.json({ preference: updated });
    } else {
      const [created] = await db
        .insert(userHotkeyPreferences)
        .values({
          userId,
          hotkeyId,
          binding,
        })
        .returning();

      return NextResponse.json({ preference: created });
    }
  } catch (error) {
    loggers.api.error('Error updating hotkey preference:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update hotkey preference' },
      { status: 500 }
    );
  }
}
