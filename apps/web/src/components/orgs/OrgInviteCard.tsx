'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { MarketingLink } from '@/components/ui/MarketingLink';
import { useAuth } from '@/hooks/useAuth';
import { ApiRequestError, post } from '@/lib/auth/auth-fetch';
import { orgHubPath, orgInvitePagePath, screenAfterAccept, type AcceptOutcome, type OrgInviteScreen } from '@/lib/orgs/org-invite-view';
import { ORG_LAPSED_MESSAGE } from '@pagespace/lib/organizations/status-core';
import type { OrgInviteView } from '@pagespace/lib/organizations/invite-view-core';

export interface OrgInviteCardProps {
  token: string;
  view: OrgInviteView;
  orgId: string;
  orgName: string;
  inviterName: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  invitedEmail: string;
  viewerEmail: string | null;
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{children}</h1>;
}

function Strong({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-gray-900 dark:text-gray-100">{children}</span>;
}

async function acceptToken(token: string): Promise<AcceptOutcome> {
  try {
    const result = await post<{ orgId: string; joined: boolean }>('/api/orgs/invitations/accept', { token });
    return { ok: true, orgId: result.orgId, joined: result.joined };
  } catch (error) {
    const body = error instanceof ApiRequestError ? error.body : undefined;
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : null;
    return { ok: false, code };
  }
}

/**
 * The org branch of the invite page (ORG-3). Every screen the invitation can be in: sign in or
 * sign up with the token carried as `?invite=` (accepted as the session is created, for every
 * auth method), accept as the invited account, the wrong account, already a member, expired,
 * no longer valid, and the org being lapsed.
 */
export function OrgInviteCard(props: OrgInviteCardProps) {
  const { token, orgId, orgName, inviterName, role, invitedEmail, viewerEmail } = props;
  const router = useRouter();
  const { actions } = useAuth();
  const [screen, setScreen] = useState<OrgInviteScreen>(props.view);
  const [busy, setBusy] = useState(false);
  const encodedToken = encodeURIComponent(token);
  const roleLabel = role === 'ADMIN' ? 'an Admin' : 'a member';

  const onAccept = async () => {
    setBusy(true);
    const outcome = await acceptToken(token);
    const next = screenAfterAccept(outcome);
    if (next === 'joined') {
      router.push(orgHubPath(orgId));
      return;
    }
    setBusy(false);
    setScreen(next);
  };

  const onSwitchAccount = async () => {
    setBusy(true);
    await actions.logout();
    window.location.assign(orgInvitePagePath(token));
  };

  if (screen === 'invalid' || screen === 'expired' || screen === 'org_lapsed' || screen === 'failed') {
    const copy = {
      invalid: 'This link was revoked, replaced by a newer one, or already used. Ask an Owner or Admin of the organization to send you a new invitation.',
      expired: 'Invitations last 7 days. Ask an Owner or Admin of the organization to send you a new one.',
      org_lapsed: ORG_LAPSED_MESSAGE,
      failed: 'Something went wrong accepting the invitation. Please try again.',
    }[screen];
    return (
      <div className="text-center" data-testid={`org-invite-${screen}`}>
        <Heading>{screen === 'expired' ? 'This invitation has expired' : screen === 'org_lapsed' ? `${orgName} can't add members right now` : screen === 'failed' ? 'Could not join' : 'This invitation is no longer valid'}</Heading>
        <p className="mt-3 text-sm text-muted-foreground">{copy}</p>
        <div className="mt-8">
          <Link href="/dashboard">
            <Button variant="outline" className="w-full">Go to PageSpace</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (screen === 'already_member') {
    return (
      <div className="text-center" data-testid="org-invite-already_member">
        <Heading>You&apos;re already a member of {orgName}</Heading>
        <div className="mt-8">
          <Link href={orgHubPath(orgId)}>
            <Button className="w-full">Open {orgName}</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (screen === 'wrong_account') {
    return (
      <div className="space-y-6 text-center" data-testid="org-invite-wrong_account">
        <Heading>This invitation is for another account</Heading>
        <p className="text-sm text-muted-foreground">
          It was sent to <Strong>{invitedEmail}</Strong>
          {viewerEmail ? <>, but you&apos;re signed in as <Strong>{viewerEmail}</Strong></> : null}. Sign out, then open
          the link again and sign in or create an account with {invitedEmail}.
        </p>
        <Button className="w-full" onClick={onSwitchAccount} disabled={busy}>
          Sign out and use another account
        </Button>
      </div>
    );
  }

  // sign_in, sign_up, accept: the invitation itself.
  return (
    <div className="space-y-6" data-testid={`org-invite-${screen}`}>
      <div className="text-center">
        <Heading>
          Join <span className="text-blue-600 dark:text-blue-400">{orgName}</span>
        </Heading>
        <p className="mt-3 text-sm text-muted-foreground">
          <Strong>{inviterName}</Strong> invited <Strong>{invitedEmail}</Strong> to join as {roleLabel}.
        </p>
      </div>

      {screen === 'accept' ? (
        <Button className="w-full" onClick={onAccept} disabled={busy}>
          {busy ? 'Joining…' : `Join ${orgName}`}
        </Button>
      ) : (
        <>
          <div className="rounded-lg border border-gray-200 bg-white/60 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
            <p>
              By continuing, you agree to PageSpace&apos;s{' '}
              <MarketingLink href="/terms" className="underline hover:text-foreground">Terms</MarketingLink>
              {' '}and{' '}
              <MarketingLink href="/privacy" className="underline hover:text-foreground">Privacy Policy</MarketingLink>.
            </p>
          </div>
          <Link href={screen === 'sign_in' ? `/auth/signin?invite=${encodedToken}` : `/auth/signup?invite=${encodedToken}`}>
            <Button className="w-full">{screen === 'sign_in' ? 'Sign in to join' : 'Create account & join'}</Button>
          </Link>
          <p className="text-center text-xs text-muted-foreground/70">
            Use {invitedEmail}: the invitation works only for that address.
          </p>
        </>
      )}
    </div>
  );
}
