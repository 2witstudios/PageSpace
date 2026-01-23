import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createVerificationToken } from '@pagespace/lib';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { VerificationEmail } from '@pagespace/lib/email-templates/VerificationEmail';
import { loggers } from '@pagespace/lib/server';
import { db, users, eq } from '@pagespace/db';
import React from 'react';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }

    // Fetch user details from database
    const [user] = await db
      .select({ id: users.id, email: users.email, name: users.name, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1);

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Check if email is already verified
    if (user.emailVerified) {
      return NextResponse.json(
        { error: 'Email is already verified' },
        { status: 400 }
      );
    }

    // Create new verification token
    const verificationToken = await createVerificationToken({
      userId: user.id,
      type: 'email_verification',
    });

    const baseUrl = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const verificationUrl = `${baseUrl}/api/auth/verify-email?token=${verificationToken}`;

    // Send verification email (rate limited in sendEmail function)
    try {
      await sendEmail({
        to: user.email,
        subject: 'Verify your PageSpace email',
        react: React.createElement(VerificationEmail, {
          userName: user.name,
          verificationUrl
        }),
      });

      loggers.auth.info('Verification email resent', { userId: user.id, email: user.email });

      return NextResponse.json({
        message: 'Verification email sent successfully. Please check your inbox.'
      });
    } catch (error) {
      // Check if it's a rate limit error
      if (error instanceof Error && error.message.includes('Too many emails')) {
        return NextResponse.json(
          { error: error.message },
          { status: 429 }
        );
      }
      throw error;
    }
  } catch (error) {
    loggers.auth.error('Error resending verification email', error as Error);
    return NextResponse.json(
      { error: 'Failed to send verification email' },
      { status: 500 }
    );
  }
}
