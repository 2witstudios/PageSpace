import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, markEmailVerified, markEmailVerifiedForAddress } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');

    if (!token) {
      return NextResponse.json({ error: 'Verification token is required' }, { status: 400 });
    }

    const verified = await verifyToken(token, 'email_verification');

    if (!verified) {
      return NextResponse.json(
        { error: 'Invalid or expired verification token' },
        { status: 400 }
      );
    }

    const { userId } = verified;

    // Parse the address this token was bound to (if any). Tokens minted after
    // address-binding shipped carry the target email so we never verify an
    // address other than the one the link was sent to. A null metadata is a
    // legacy (pre-binding) token; present-but-unparseable metadata is corrupt
    // and must NOT silently fall through to the unbound path.
    let boundEmail: string | null = null;
    if (verified.metadata) {
      try {
        boundEmail = (JSON.parse(verified.metadata) as { email?: string }).email ?? null;
      } catch {
        loggers.auth.warn('Email verification token has unparseable metadata', { userId });
        return NextResponse.json(
          { error: 'Invalid or expired verification token' },
          { status: 400 }
        );
      }
    }

    if (boundEmail) {
      // Mark verified ONLY if the user's current email still matches the bound
      // address. If it changed since the token was issued, refuse — otherwise a
      // token sent to a controlled inbox could verify a different, unowned one.
      const marked = await markEmailVerifiedForAddress(userId, boundEmail);
      if (!marked) {
        loggers.auth.warn('Email verification token did not match current address', { userId });
        return NextResponse.json(
          { error: 'Invalid or expired verification token' },
          { status: 400 }
        );
      }
    } else {
      // Legacy token issued before address binding — preserve prior behavior.
      await markEmailVerified(userId);
    }

    // Log verification
    loggers.auth.info('Email verified', { userId });
    trackAuthEvent(userId, 'email_verified', {});
    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'email_verification', resourceId: userId });

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
