import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { driveRoles } from '@pagespace/db/schema/members';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { validateAuthorizeRequest, type AuthorizeRequestParams } from '@pagespace/lib/auth/oauth/authorize-request';
import { getRegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { describeScopeForConsent } from '@pagespace/lib/auth/oauth/consent';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { ConsentActions } from './ConsentActions';

interface ConsentPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ConsentPage({ searchParams }: ConsentPageProps) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const v = first(value);
    if (v !== undefined) query.set(key, v);
  }

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const sessionToken = getSessionFromCookies(cookieHeader);
  const nextTarget = `/oauth/consent?${query.toString()}`;

  if (!sessionToken) {
    redirect(`/auth/signin?next=${encodeURIComponent(nextTarget)}`);
  }

  // Consent screen is gated on a real browser session only.
  const session = await sessionService.validateSession(sessionToken, { expectedType: 'user' });
  if (!session) {
    redirect(`/auth/signin?next=${encodeURIComponent(nextTarget)}`);
  }

  const authorizeParams: AuthorizeRequestParams = {
    clientId: first(params.client_id),
    redirectUri: first(params.redirect_uri),
    responseType: first(params.response_type),
    codeChallenge: first(params.code_challenge),
    codeChallengeMethod: first(params.code_challenge_method),
    scope: first(params.scope),
    state: first(params.state),
  };
  const client = authorizeParams.clientId ? getRegisteredClient(authorizeParams.clientId) : null;
  const result = validateAuthorizeRequest(authorizeParams, client);

  if (!result.ok) {
    if (result.kind === 'no_redirect') {
      return (
        <div className="mx-auto max-w-md py-16 text-center">
          <h1 className="text-xl font-semibold">Authorization error</h1>
          <p className="mt-2 text-muted-foreground">
            {result.error === 'invalid_client' ? 'Unknown client.' : 'Invalid or unregistered redirect_uri.'}
          </p>
        </div>
      );
    }
    // Defense in depth: /api/oauth/authorize should already have redirected
    // this case before ever reaching the consent screen.
    const url = new URL(result.redirectUri);
    url.searchParams.set('error', result.error);
    if (result.state) url.searchParams.set('state', result.state);
    redirect(url.toString());
  }

  const driveIds = [...result.scopes.drives.keys()];
  const drives = driveIds.length > 0 ? await sessionRepository.findDrivesByIds(driveIds) : [];
  const driveNamesById = new Map(drives.map((d) => [d.id, d.name]));

  const customRoleIds = [...result.scopes.drives.values()]
    .filter((scope) => scope.role.kind === 'custom')
    .map((scope) => (scope.role as { kind: 'custom'; customRoleId: string }).customRoleId);
  const roleRows =
    customRoleIds.length > 0
      ? await Promise.all(customRoleIds.map((id) => db.query.driveRoles.findFirst({ where: eq(driveRoles.id, id) })))
      : [];
  const roleById = new Map(roleRows.filter((r): r is NonNullable<typeof r> => !!r).map((r) => [r.id, r]));

  const scopeDescriptions: string[] = [];
  if (result.scopes.account) {
    scopeDescriptions.push(describeScopeForConsent({ kind: 'account' }, {}));
  }
  if (result.scopes.offlineAccess) {
    scopeDescriptions.push(describeScopeForConsent({ kind: 'offline_access' }, {}));
  }
  for (const scope of result.scopes.drives.values()) {
    const driveName = driveNamesById.get(scope.driveId);
    if (scope.role.kind === 'custom') {
      const role = roleById.get(scope.role.customRoleId);
      scopeDescriptions.push(
        describeScopeForConsent(scope, { driveName, roleName: role?.name, roleSummary: role?.description ?? undefined }),
      );
    } else {
      scopeDescriptions.push(describeScopeForConsent(scope, { driveName }));
    }
  }

  return (
    <div className="mx-auto max-w-md py-16">
      <h1 className="text-xl font-semibold">
        {result.client.name} is requesting access
        {result.client.firstParty && (
          <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
            Built by PageSpace
          </span>
        )}
      </h1>
      <ul className="mt-6 space-y-3 text-sm">
        {scopeDescriptions.map((text, i) => (
          <li key={i} className="rounded border p-3">
            {text}
          </li>
        ))}
      </ul>
      <ConsentActions
        clientId={authorizeParams.clientId!}
        redirectUri={result.redirectUri}
        responseType={authorizeParams.responseType!}
        codeChallenge={result.codeChallenge}
        codeChallengeMethod={authorizeParams.codeChallengeMethod!}
        scope={authorizeParams.scope!}
        state={result.state}
      />
    </div>
  );
}
