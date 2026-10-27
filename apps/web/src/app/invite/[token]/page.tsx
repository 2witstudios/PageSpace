import Link from 'next/link';
import { MarketingLink } from '@/components/ui/MarketingLink';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { Button } from '@/components/ui/button';
import { cookies } from 'next/headers';
import { resolveInviteContext } from '@/lib/auth/invite-resolver';
import { loadOrgInvitePage } from '@/lib/orgs/org-invite-page';
import { OrgInviteCard } from '@/components/orgs/OrgInviteCard';
import { isV3AuthEnabled } from '@/lib/imago/v3-auth-enabled';
import { InviteCardV3 } from './InviteCardV3';

interface InvitePageProps {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const resolution = await resolveInviteContext({ token, now: new Date() });

  // ORG-3: an org invitation link opens here too; its screen depends on who is signed in.
  // Asked before the Imago V3 card: an org token is not a user invite, and the generic
  // resolver would answer NOT_FOUND for it.
  const orgInvite = await loadOrgInvitePage({ token, cookieHeader: (await cookies()).toString(), now: new Date() });
  if (orgInvite) {
    return (
      <AuthLayout>
        <OrgInviteCard token={token} model={orgInvite} />
      </AuthLayout>
    );
  }

  if (isV3AuthEnabled()) {
    return (
      <AuthLayout>
        <InviteCardV3 resolution={resolution} token={token} />
      </AuthLayout>
    );
  }

  if (!resolution.ok) {
    // Render the same opaque card for NOT_FOUND / EXPIRED / CONSUMED — never
    // disclose which specific reason caused the rejection (would leak token
    // existence + state).
    return (
      <AuthLayout>
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
      </AuthLayout>
    );
  }

  const { data } = resolution;
  const encodedToken = encodeURIComponent(token);

  if (data.kind === 'page') {
    const ctaHref = data.isExistingUser
      ? `/auth/signin?invite=${encodedToken}`
      : `/auth/signup?invite=${encodedToken}`;
    const ctaLabel = data.isExistingUser ? 'Sign in to access' : 'Create account & access';

    return (
      <AuthLayout>
        <div className="space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
              <span className="text-blue-600 dark:text-blue-400">{data.inviterName}</span>
              {' '}has shared a page with you
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              <span className="font-medium text-gray-900 dark:text-gray-100">&ldquo;{data.pageTitle}&rdquo;</span>
              {' '}in{' '}
              <span className="font-medium text-gray-900 dark:text-gray-100">{data.driveName}</span>
              {' '}was shared with{' '}
              <span className="font-medium text-gray-900 dark:text-gray-100">{data.email}</span>.
            </p>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white/60 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
            <p>
              By continuing, you agree to PageSpace&apos;s{' '}
              <MarketingLink href="/terms" className="underline hover:text-foreground">Terms</MarketingLink>
              {' '}and{' '}
              <MarketingLink href="/privacy" className="underline hover:text-foreground">Privacy Policy</MarketingLink>.
            </p>
          </div>

          <Link href={ctaHref}>
            <Button className="w-full">{ctaLabel}</Button>
          </Link>

          <p className="text-center text-xs text-muted-foreground/70">
            Not {data.email}? Sign out of any other account first, then return to this link.
          </p>
        </div>
      </AuthLayout>
    );
  }

  if (data.kind === 'connection') {
    const ctaHref = data.isExistingUser
      ? `/auth/signin?invite=${encodedToken}`
      : `/auth/signup?invite=${encodedToken}`;
    const ctaLabel = data.isExistingUser ? 'Sign in to connect' : 'Create account & connect';

    return (
      <AuthLayout>
        <div className="space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
              <span className="text-blue-600 dark:text-blue-400">{data.inviterName}</span>
              {' '}wants to connect with you
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              This invitation was sent to{' '}
              <span className="font-medium text-gray-900 dark:text-gray-100">{data.email}</span>.
            </p>
          </div>

          {data.message && (
            <div className="rounded-lg border border-gray-200 bg-white/60 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300 italic">
              &ldquo;{data.message}&rdquo;
            </div>
          )}

          <div className="rounded-lg border border-gray-200 bg-white/60 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
            <p>
              By continuing, you agree to PageSpace&apos;s{' '}
              <MarketingLink href="/terms" className="underline hover:text-foreground">Terms</MarketingLink>
              {' '}and{' '}
              <MarketingLink href="/privacy" className="underline hover:text-foreground">Privacy Policy</MarketingLink>.
            </p>
          </div>

          <Link href={ctaHref}>
            <Button className="w-full">{ctaLabel}</Button>
          </Link>

          <p className="text-center text-xs text-muted-foreground/70">
            Not {data.email}? Sign out of any other account first, then return to this link.
          </p>
        </div>
      </AuthLayout>
    );
  }

  // kind === 'drive'
  const ctaHref = data.isExistingUser
    ? `/auth/signin?invite=${encodedToken}`
    : `/auth/signup?invite=${encodedToken}`;
  const ctaLabel = data.isExistingUser ? 'Sign in to join' : 'Create account & join';

  return (
    <AuthLayout>
      <div className="space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            You&apos;re invited to <span className="text-blue-600 dark:text-blue-400">{data.driveName}</span>
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            <span className="font-medium text-gray-900 dark:text-gray-100">{data.inviterName}</span>
            {' '}invited{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100">{data.email}</span>
            {' '}to join as a{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100">{data.role.toLowerCase()}</span>.
          </p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white/60 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
          <p>
            By continuing, you agree to PageSpace&apos;s{' '}
            <MarketingLink href="/terms" className="underline hover:text-foreground">Terms</MarketingLink>
            {' '}and{' '}
            <MarketingLink href="/privacy" className="underline hover:text-foreground">Privacy Policy</MarketingLink>.
          </p>
        </div>

        <Link href={ctaHref}>
          <Button className="w-full">{ctaLabel}</Button>
        </Link>

        <p className="text-center text-xs text-muted-foreground/70">
          Not {data.email}? Sign out of any other account first, then return to this link.
        </p>
      </div>
    </AuthLayout>
  );
}
