import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { userHotkeyPreferences } from '@pagespace/db/schema/hotkeys';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';
import { getHotkeyDefinition } from '@/lib/hotkeys/registry';
import { isUsableBinding } from '@/lib/hotkeys/binding';

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

    // An empty binding disables the hotkey. Anything else must be in the
    // canonical format so it can actually match a key event.
    if (binding !== '' && !isUsableBinding(binding)) {
      return NextResponse.json(
        { error: 'Binding must be a supported key combination with at least one modifier' },
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

      audit({ eventType: 'admin.settings.changed', userId, resourceType: 'hotkey_preference' });
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

      audit({ eventType: 'admin.settings.changed', userId, resourceType: 'hotkey_preference' });
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

// DELETE /api/settings/hotkey-preferences - Remove an override (back to default)
export async function DELETE(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { hotkeyId, ifBinding } = body;

    if (!hotkeyId || typeof hotkeyId !== 'string') {
      return NextResponse.json({ error: 'hotkeyId is required' }, { status: 400 });
    }

    if (ifBinding !== undefined && typeof ifBinding !== 'string') {
      return NextResponse.json({ error: 'ifBinding must be a string' }, { status: 400 });
    }

    // `ifBinding` makes the delete conditional on the row still holding the
    // value the caller inspected — the binding is its own version token.
    // Settings uses it when dismissing the "these were reset" notice: it reads
    // the server, decides which rows cannot fire, then deletes them, and
    // another tab can save a real shortcut in between. Without the condition
    // that save is discarded. Omitting it deletes unconditionally, which is
    // what the per-shortcut Reset button means.
    await db
      .delete(userHotkeyPreferences)
      .where(and(
        eq(userHotkeyPreferences.userId, userId),
        eq(userHotkeyPreferences.hotkeyId, hotkeyId),
        ...(ifBinding === undefined ? [] : [eq(userHotkeyPreferences.binding, ifBinding)])
      ));

    audit({ eventType: 'admin.settings.changed', userId, resourceType: 'hotkey_preference' });
    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting hotkey preference:', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete hotkey preference' },
      { status: 500 }
    );
  }
}
