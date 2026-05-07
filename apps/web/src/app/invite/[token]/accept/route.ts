import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { acceptInviteForExistingUser } from '@/lib/auth/invite-acceptance';
import { loggers } from '@pagespace/lib/logging/logger-config';

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const encodedToken = encodeURIComponent(token);
  const url = new URL(request.url);
  const origin = url.origin;

  const auth = await authenticateRequestWithOptions(request, { allow: ['session'] });
  if (isAuthError(auth)) {
    // Send the unauthenticated user through the standard signin flow. After
    // signin, the user can re-click the link (two-click fallback) — full `next=`
    // plumbing is documented as a follow-up; the redirect parameters are
    // included here so the consuming flow has them available.
    return NextResponse.redirect(
      `${origin}/auth/signin?invite=${encodedToken}&next=${encodeURIComponent(`/invite/${encodedToken}/accept`)}`,
      { status: 303 },
    );
  }

  const status = await driveInviteRepository.findUserVerificationStatusById(auth.userId);
  if (!status) {
    loggers.api.warn('Authenticated session has no user record on invite accept', {
      userId: auth.userId,
    });
    return NextResponse.redirect(`${origin}/dashboard?inviteError=TOKEN_NOT_FOUND`, { status: 303 });
  }

  // Defense-in-depth: authenticateSessionRequest already rejects suspended
  // users at the session layer, but reading suspendedAt here makes the gate
  // explicit and survives any future refactor of the auth helpers. A
  // suspended user must not consume a pending invite.
  if (status.suspendedAt) {
    return NextResponse.redirect(
      `${origin}/dashboard?inviteError=ACCOUNT_SUSPENDED`,
      { status: 303 },
    );
  }

  const result = await acceptInviteForExistingUser({
    token,
    userId: auth.userId,
    userEmail: status.email,
    now: new Date(),
  });

  if (!result.ok) {
    return NextResponse.redirect(
      `${origin}/dashboard?inviteError=${result.error}`,
      { status: 303 },
    );
  }

  return NextResponse.redirect(
    `${origin}/dashboard/${result.data.driveId}?invited=1`,
    { status: 303 },
  );
}
