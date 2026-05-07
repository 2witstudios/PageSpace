import { redirect } from 'next/navigation';
import { resolveInviteContext } from '@/lib/auth/invite-resolver';
import { isOnPrem } from '@/lib/deployment-mode';
import { SignUpClient } from './SignUpClient';

interface SignUpPageProps {
  searchParams: Promise<{ invite?: string }>;
}

export default async function SignUp({ searchParams }: SignUpPageProps) {
  if (isOnPrem()) {
    // Self-registration disabled on-prem; redirect to signin with banner.
    redirect('/auth/signin?onprem=contact_admin');
  }

  const { invite } = await searchParams;

  if (!invite) {
    return <SignUpClient />;
  }

  const resolution = await resolveInviteContext({ token: invite, now: new Date() });
  if (!resolution.ok) {
    // Don't surface invite-resolution errors here — render the consent page
    // for the same opaque-card treatment. This also re-resolves server-side
    // (DevTools tampering of the URL token cannot bypass).
    redirect(`/invite/${encodeURIComponent(invite)}`);
  }

  return <SignUpClient inviteToken={invite} inviteContext={resolution.data} />;
}
