import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { isV3AuthEnabled } from '@/lib/imago/v3-auth-enabled';
import { getViewerDisplayName } from '@/lib/auth/viewer-display-name';
import { isAgentDoorOpen } from '@/lib/agent-auth/door';
import { ClaimFlow } from './ClaimFlow';

interface ClaimPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The agent claim page (ADR 0008, Agent Signup Phase 4; auth.md "Fund"
 * `verification_uri`): an agent hands a human `/claim?user_code=…`, the human
 * signs in AS THEMSELVES and approves paying for its AI usage. Session-gated
 * exactly like `/activate`; the code itself is verified and rate-limited
 * server-side by ClaimFlow's calls, never trusted from this render. A
 * deployment with the agent door closed has no claim page (404).
 */
export default async function ClaimPage({ searchParams }: ClaimPageProps) {
  if (!isAgentDoorOpen()) notFound();

  const params = await searchParams;
  const userCode = first(params.user_code) ?? '';
  const nextTarget = userCode ? `/claim?user_code=${encodeURIComponent(userCode)}` : '/claim';

  const cookieStore = await cookies();
  const sessionToken = getSessionFromCookies(cookieStore.toString());
  if (!sessionToken) {
    redirect(`/auth/signin?next=${encodeURIComponent(nextTarget)}`);
  }

  const session = await sessionService.validateSession(sessionToken, { expectedType: 'user' });
  if (!session) {
    redirect(`/auth/signin?next=${encodeURIComponent(nextTarget)}`);
  }

  // The v3 entry heading is rendered by ClaimFlow so it can change per step.
  const v3 = isV3AuthEnabled();
  const signedInAs = v3 ? await getViewerDisplayName(session.userId) : undefined;

  return (
    <AuthLayout classic="bare" {...(signedInAs ? { signedInAs } : {})}>
      {!v3 && (
        <>
          <h1 className="text-xl font-semibold">Claim an AI agent</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter the code your agent gave you. Claiming an agent links it to your account, and you pay for its AI usage.
          </p>
        </>
      )}
      <ClaimFlow initialUserCode={userCode} />
    </AuthLayout>
  );
}
