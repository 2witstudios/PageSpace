import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import bcrypt from 'bcryptjs';
import { db, users, userAiSettings, eq } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { BCRYPT_COST } from '@pagespace/lib/auth';
import { withAdminAuth } from '@/lib/auth/auth';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { loggers } from '@pagespace/lib/server';

const createUserSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.email(),
  password: z.string()
    .min(12, 'Password must be at least 12 characters long')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  role: z.enum(['user', 'admin']).default('user'),
});

export const POST = withAdminAuth(async (adminUser, request) => {
  try {
    const body = await request.json();
    const parsed = createUserSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const { name, email, password, role } = parsed.data;
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

    const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);
    const userId = createId();
    const isOnPrem = process.env.DEPLOYMENT_MODE === 'onprem';

    await db.insert(users).values({
      id: userId,
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role,
      emailVerified: new Date(), // Admin-created accounts are pre-verified
      subscriptionTier: isOnPrem ? 'business' : 'free',
    });

    // Create default Ollama AI settings (on-prem default local provider)
    if (isOnPrem) {
      await db.insert(userAiSettings).values({
        id: createId(),
        userId,
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
      });
    }

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
