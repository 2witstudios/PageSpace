import { NextRequest, NextResponse } from 'next/server';
import { db, eq, users } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId: targetUserId } = await context.params;

    // Verify user is authenticated and is an admin
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    if (auth.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden: Admin access required' },
        { status: 403 }
      );
    }

    const currentUserId = auth.userId;

    // Parse request body
    const body = await request.json();
    const { subscriptionTier } = body;

    // Validate subscription tier
    if (!subscriptionTier || !['free', 'pro', 'business'].includes(subscriptionTier)) {
      return NextResponse.json(
        { error: 'Invalid subscription tier. Must be "free", "pro", or "business"' },
        { status: 400 }
      );
    }

    // Check if user exists
    const [existingUser] = await db
      .select({ id: users.id, name: users.name, subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, targetUserId));

    if (!existingUser) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Update user subscription tier - storage limits will be computed dynamically
    await db
      .update(users)
      .set({
        subscriptionTier: subscriptionTier as 'free' | 'pro' | 'business',
        updatedAt: new Date(),
      })
      .where(eq(users.id, targetUserId));

    // Log the admin action
    loggers.api.info('Admin subscription update', {
      adminId: currentUserId,
      targetUserId: targetUserId,
      targetUserName: existingUser.name,
      oldTier: existingUser.subscriptionTier,
      newTier: subscriptionTier,
    });

    return NextResponse.json({
      success: true,
      message: `User subscription updated from ${existingUser.subscriptionTier} to ${subscriptionTier}`,
      data: {
        userId: targetUserId,
        oldTier: existingUser.subscriptionTier,
        newTier: subscriptionTier,
      },
    });

  } catch (error) {
    loggers.api.error('Error updating user subscription:', error as Error);

    return NextResponse.json(
      {
        error: 'Failed to update user subscription',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}