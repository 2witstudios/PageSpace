import { redirect } from 'next/navigation';
import { resolveInviteContext } from '@/lib/auth/invite-resolver';
import { isOnPrem } from '@/lib/deployment-mode';
import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from '@/lib/auth/auth-helpers';
import { SignUpClient } from './SignUpClient';

interface SignUpPageProps {
  searchParams: Promise<{ invite?: string; next?: string }>;
}

export default async function SignUp({ searchParams }: SignUpPageProps) {
  if (isOnPrem()) {
    // Self-registration disabled on-prem; redirect to signin with banner.
    redirect('/auth/signin?onprem=contact_admin');
  }

  const { invite, next } = await searchParams;
  const safeNext = next && isSafeNextPath({ path: next, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES })
    ? next
    : undefined;

  if (!invite) {
    return <SignUpClient {...(safeNext && { returnUrl: safeNext })} />;
  }

  const resolution = await resolveInviteContext({ token: invite, now: new Date() });
  if (!resolution.ok) {
    // Don't surface invite-resolution errors here — render the consent page
    // for the same opaque-card treatment. This also re-resolves server-side
    // (DevTools tampering of the URL token cannot bypass).
    redirect(`/invite/${encodeURIComponent(invite)}`);
  }

  return <SignUpClient inviteToken={invite} inviteContext={resolution.data} {...(safeNext && { returnUrl: safeNext })} />;
}
