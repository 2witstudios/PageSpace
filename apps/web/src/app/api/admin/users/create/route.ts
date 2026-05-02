import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { createId } from '@paralleldrive/cuid2';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { getOnPremUserDefaults } from '@pagespace/lib/onprem-defaults';
import { withAdminAuth } from '@/lib/auth/auth';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { loggers } from '@pagespace/lib/logging/logger-config';

const createUserSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.email(),
  role: z.enum(['user', 'admin']).default('user'),
});

export const POST = withAdminAuth(async (adminUser, request) => {
  try {
    const body = await request.json();
    const parsed = createUserSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { name, email, role } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Check for existing user
    const existing = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
      columns: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        { error: 'A user with this email already exists' },
        { status: 409 }
      );
    }

    const userId = createId();
    const onPrem = isOnPrem();

    await db.insert(users).values({
      id: userId,
      name: name.trim(),
      email: normalizedEmail,
      role,
      emailVerified: new Date(), // Admin-created accounts are pre-verified
      ...(onPrem ? getOnPremUserDefaults() : { subscriptionTier: 'free' }),
    });

    // Provision Getting Started drive
    try {
      await provisionGettingStartedDriveIfNeeded(userId);
    } catch (error) {
      loggers.api.warn('Failed to provision Getting Started drive for admin-created user', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    loggers.api.info('Admin created user account', {
      adminId: adminUser.id,
      newUserId: userId,
      role,
    });

    return NextResponse.json(
      { success: true, userId, message: `User ${normalizedEmail} created successfully` },
      { status: 201 }
    );
  } catch (error) {
    loggers.api.error('Failed to create user', error as Error);
    return NextResponse.json(
      { error: 'Failed to create user' },
      { status: 500 }
    );
  }
});
