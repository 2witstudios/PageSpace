import { NextResponse } from 'next/server';
import { db, userPersonalization, eq } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

// Maximum length for text fields (~10k tokens to support detailed memory/instructions)
const MAX_FIELD_LENGTH = 40000;

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

    // Guard against non-object JSON bodies
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const { bio, writingStyle, rules, enabled } = body;

    // Validate that at least one field is provided
    if (bio === undefined && writingStyle === undefined && rules === undefined && enabled === undefined) {
      return NextResponse.json(
        { error: 'At least one field (bio, writingStyle, rules, enabled) is required' },
        { status: 400 }
      );
    }

    // Type validation
    if (bio !== undefined && typeof bio !== 'string') {
      return NextResponse.json({ error: 'bio must be a string' }, { status: 400 });
    }
    if (writingStyle !== undefined && typeof writingStyle !== 'string') {
      return NextResponse.json({ error: 'writingStyle must be a string' }, { status: 400 });
    }
    if (rules !== undefined && typeof rules !== 'string') {
      return NextResponse.json({ error: 'rules must be a string' }, { status: 400 });
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }

    // Length validation to prevent excessively long system prompts
    if (bio && bio.length > MAX_FIELD_LENGTH) {
      return NextResponse.json(
        { error: `bio must be ${MAX_FIELD_LENGTH} characters or less` },
        { status: 400 }
      );
    }
    if (writingStyle && writingStyle.length > MAX_FIELD_LENGTH) {
      return NextResponse.json(
        { error: `writingStyle must be ${MAX_FIELD_LENGTH} characters or less` },
        { status: 400 }
      );
    }
    if (rules && rules.length > MAX_FIELD_LENGTH) {
      return NextResponse.json(
        { error: `rules must be ${MAX_FIELD_LENGTH} characters or less` },
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

    // Atomic upsert to eliminate race condition with concurrent requests
    const [record] = await db
      .insert(userPersonalization)
      .values({
        userId,
        bio: bio ?? '',
        writingStyle: writingStyle ?? '',
        rules: rules ?? '',
        enabled: enabled ?? true,
      })
      .onConflictDoUpdate({
        target: userPersonalization.userId,
        set: updateData,
      })
      .returning();

    return NextResponse.json({
      personalization: {
        bio: record.bio ?? '',
        writingStyle: record.writingStyle ?? '',
        rules: record.rules ?? '',
        enabled: record.enabled,
      },
    });
  } catch (error) {
    loggers.api.error('Error updating personalization settings:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update personalization settings' },
      { status: 500 }
    );
  }
}
