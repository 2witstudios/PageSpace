import Link from 'next/link';
import { resolveInviteContext } from '@/lib/auth/invite-resolver';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// Server component. Resolves the invite token and renders a consent screen.
// Per zero-trust + GDPR: no users row is created here, and the invite token
// has zero authentication power. Clicking the CTA routes to /auth/signup or
// /auth/login depending on whether the invited email already has a fully-
// onboarded account (tosAcceptedAt IS NOT NULL).
//
// Invalid/expired/consumed tokens render an opaque "no longer valid" page —
// never redirect to signup or login, which would leak that the token ever
// existed.

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: PageProps) {
  // Next.js 15: params is a Promise. Destructuring directly is a silent bug.
  const { token } = await params;
  const resolution = await resolveInviteContext({ token, now: new Date() });

  if (!resolution.ok) {
    return <InviteUnavailable />;
  }

  const { driveName, inviterName, role, email, isExistingUser } = resolution.data;
  const ctaHref = isExistingUser
    ? `/auth/login?invite=${encodeURIComponent(token)}`
    : `/auth/signup?invite=${encodeURIComponent(token)}`;
  const ctaLabel = isExistingUser ? 'Sign in to join' : 'Create account & join';

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">You&apos;ve been invited</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{inviterName}</span> invited{' '}
            <span className="font-medium text-foreground">{email}</span> to join{' '}
            <span className="font-medium text-foreground">{driveName}</span> as a{' '}
            <span className="font-medium text-foreground">{role.toLowerCase()}</span>.
          </p>
          <p className="text-xs text-muted-foreground">
            By continuing you&apos;ll be asked to review and accept our{' '}
            <Link href="/terms" className="underline hover:text-foreground">
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="underline hover:text-foreground">
              Privacy Policy
            </Link>
            {isExistingUser ? ' (already accepted on your existing account).' : '.'}
          </p>
          <Button asChild className="w-full">
            <Link href={ctaHref}>{ctaLabel}</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

function InviteUnavailable() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">This invite is no longer valid</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The invitation may have expired, already been used, or been revoked. Ask the
            person who invited you to send a fresh one.
          </p>
          <Button asChild variant="outline" className="w-full">
            <Link href="/">Return to home</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
