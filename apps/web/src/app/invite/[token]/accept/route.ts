import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { acceptInviteForExistingUser } from '@/lib/auth/invite-acceptance';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

// Existing-user invite acceptance gateway. The /invite/[token] consent page's
// "Sign in to join" CTA routes here. If unauthenticated, redirect to signin
// with a `next=` param so the user comes back here after login. If
// authenticated, run acceptInviteForExistingUser and redirect to the drive
// (or to the dashboard with an inviteError on failure).
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const accept = `/invite/${encodeURIComponent(token)}/accept`;

  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    const next = encodeURIComponent(accept);
    return NextResponse.redirect(
      new URL(`/auth/signin?invite=${encodeURIComponent(token)}&next=${next}`, request.url)
    );
  }

  const userInfo = await driveInviteRepository.findUserVerificationStatusById(auth.userId);
  if (!userInfo) {
    loggers.api.error('Invite accept: user not found despite valid session', undefined, {
      userId: auth.userId,
    });
    return NextResponse.redirect(new URL('/dashboard?inviteError=USER_NOT_FOUND', request.url));
  }

  const result = await acceptInviteForExistingUser({
    token,
    userId: auth.userId,
    userEmail: userInfo.email,
    now: new Date(),
  });

  if (result.ok) {
    return NextResponse.redirect(
      new URL(`/dashboard/${result.data.driveId}?invited=1`, request.url)
    );
  }

  return NextResponse.redirect(
    new URL(`/dashboard?inviteError=${encodeURIComponent(result.error)}`, request.url)
  );
}
