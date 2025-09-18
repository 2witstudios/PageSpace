import { NextRequest, NextResponse } from 'next/server';
import { db, eq, users } from '@pagespace/db';
import { verifyAdminAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logger-config';

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await context.params;

    // Verify user is authenticated and is an admin
    const adminUser = await verifyAdminAuth(request);

    if (!adminUser) {
      return NextResponse.json(
        { error: 'Unauthorized: Admin access required' },
        { status: 403 }
      );
    }

    // Parse request body
    const body = await request.json();
    const { subscriptionTier } = body;

    // Validate subscription tier
    if (!subscriptionTier || !['normal', 'pro'].includes(subscriptionTier)) {
      return NextResponse.json(
        { error: 'Invalid subscription tier. Must be "normal" or "pro"' },
        { status: 400 }
      );
    }

    // Check if user exists
    const [existingUser] = await db
      .select({ id: users.id, name: users.name, subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, userId));

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
        subscriptionTier: subscriptionTier as 'normal' | 'pro',
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    // Log the admin action
    loggers.api.info('Admin subscription update', {
      adminId: adminUser.id,
      targetUserId: userId,
      targetUserName: existingUser.name,
      oldTier: existingUser.subscriptionTier,
      newTier: subscriptionTier,
    });

    return NextResponse.json({
      success: true,
      message: `User subscription updated from ${existingUser.subscriptionTier} to ${subscriptionTier}`,
      data: {
        userId,
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