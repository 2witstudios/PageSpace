import { NextResponse } from 'next/server';
import { db, userPersonalization, eq } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

// GET /api/settings/personalization - Get user's personalization settings
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const personalization = await db.query.userPersonalization.findFirst({
      where: eq(userPersonalization.userId, userId),
    });

    // Return defaults if no personalization exists
    if (!personalization) {
      return NextResponse.json({
        personalization: {
          bio: '',
          writingStyle: '',
          rules: '',
          enabled: true,
        },
      });
    }

    return NextResponse.json({
      personalization: {
        bio: personalization.bio ?? '',
        writingStyle: personalization.writingStyle ?? '',
        rules: personalization.rules ?? '',
        enabled: personalization.enabled,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching personalization settings:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch personalization settings' },
      { status: 500 }
    );
  }
}

// PATCH /api/settings/personalization - Update personalization settings
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { bio, writingStyle, rules, enabled } = body;

    // Validate that at least one field is provided
    if (bio === undefined && writingStyle === undefined && rules === undefined && enabled === undefined) {
      return NextResponse.json(
        { error: 'At least one field (bio, writingStyle, rules, enabled) is required' },
        { status: 400 }
      );
    }

    // Build update object with only provided fields
    const updateData: {
      bio?: string;
      writingStyle?: string;
      rules?: string;
      enabled?: boolean;
      updatedAt: Date;
    } = { updatedAt: new Date() };

    if (bio !== undefined) updateData.bio = bio;
    if (writingStyle !== undefined) updateData.writingStyle = writingStyle;
    if (rules !== undefined) updateData.rules = rules;
    if (enabled !== undefined) updateData.enabled = enabled;

    // Check if personalization exists
    const existing = await db.query.userPersonalization.findFirst({
      where: eq(userPersonalization.userId, userId),
    });

    if (existing) {
      // Update existing record
      const [updated] = await db
        .update(userPersonalization)
        .set(updateData)
        .where(eq(userPersonalization.userId, userId))
        .returning();

      return NextResponse.json({
        personalization: {
          bio: updated.bio ?? '',
          writingStyle: updated.writingStyle ?? '',
          rules: updated.rules ?? '',
          enabled: updated.enabled,
        },
      });
    } else {
      // Create new record
      const [created] = await db
        .insert(userPersonalization)
        .values({
          userId,
          bio: bio ?? '',
          writingStyle: writingStyle ?? '',
          rules: rules ?? '',
          enabled: enabled ?? true,
        })
        .returning();

      return NextResponse.json({
        personalization: {
          bio: created.bio ?? '',
          writingStyle: created.writingStyle ?? '',
          rules: created.rules ?? '',
          enabled: created.enabled,
        },
      });
    }
  } catch (error) {
    loggers.api.error('Error updating personalization settings:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update personalization settings' },
      { status: 500 }
    );
  }
}
