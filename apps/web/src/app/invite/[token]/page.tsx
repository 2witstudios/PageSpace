import Link from 'next/link';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { resolveInviteContext } from '@/lib/auth/invite-resolver';

interface InvitePageProps {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const resolution = await resolveInviteContext({ token, now: new Date() });

  if (!resolution.ok) {
    // Render the same opaque card for NOT_FOUND / EXPIRED / CONSUMED — never
    // disclose which specific reason caused the rejection (would leak token
    // existence + state).
    return (
      <AuthShell>
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            This invite is no longer valid
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            The invitation link has expired or already been used. Ask the
            person who invited you to send a new one.
          </p>
          <div className="mt-8">
            <Link href="/auth/signin">
              <Button variant="outline" className="w-full">
                Go to sign in
              </Button>
            </Link>
          </div>
        </div>
      </AuthShell>
    );
  }

  const { driveName, inviterName, role, email, isExistingUser } = resolution.data;
  const encodedToken = encodeURIComponent(token);
  const ctaHref = isExistingUser
    ? `/invite/${encodedToken}/accept`
    : `/auth/signup?invite=${encodedToken}`;
  const ctaLabel = isExistingUser ? 'Sign in to join' : 'Create account & join';

  return (
    <AuthShell>
      <div className="space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            You&apos;re invited to <span className="text-blue-600 dark:text-blue-400">{driveName}</span>
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            <span className="font-medium text-gray-900 dark:text-gray-100">{inviterName}</span>
            {' '}invited{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100">{email}</span>
            {' '}to join as a{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100">{role.toLowerCase()}</span>.
          </p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white/60 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
          <p>
            By continuing, you agree to PageSpace&apos;s{' '}
            <Link href="/terms" className="underline hover:text-foreground">Terms</Link>
            {' '}and{' '}
            <Link href="/privacy" className="underline hover:text-foreground">Privacy Policy</Link>.
          </p>
        </div>

        <Link href={ctaHref}>
          <Button className="w-full">{ctaLabel}</Button>
        </Link>

        <p className="text-center text-xs text-muted-foreground/70">
          Not {email}? Sign out of any other account first, then return to this link.
        </p>
      </div>
    </AuthShell>
  );
}
