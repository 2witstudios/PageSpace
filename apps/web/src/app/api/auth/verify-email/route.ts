import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, markEmailVerified } from '@pagespace/lib/verification-utils';
import { loggers } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');

    if (!token) {
      return NextResponse.json({ error: 'Verification token is required' }, { status: 400 });
    }

    const userId = await verifyToken(token, 'email_verification');

    if (!userId) {
      return NextResponse.json(
        { error: 'Invalid or expired verification token' },
        { status: 400 }
      );
    }

    // Mark email as verified
    await markEmailVerified(userId);

    // Log verification
    loggers.auth.info('Email verified', { userId });
    trackAuthEvent(userId, 'email_verified', {});

    // Redirect to dashboard - triggers auth refresh via ?auth=success
    const baseUrl = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    return NextResponse.redirect(new URL('/dashboard?auth=success', baseUrl), {
      status: 303, // See Other - forces GET on redirect
    });
  } catch (error) {
    loggers.auth.error('Email verification error', error as Error);
    return NextResponse.json({ error: 'Email verification failed' }, { status: 500 });
  }
}
