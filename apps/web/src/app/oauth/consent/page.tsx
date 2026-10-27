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
import { AuthLayout } from '@/components/auth/AuthLayout';
import { ConsentScopeCard } from '@/components/auth/ConsentScopeCard';
import { V3_BODY, V3_HEADING } from '@/components/auth/auth-v3-styles';
import { isV3AuthEnabled } from '@/lib/imago/v3-auth-enabled';
import { getViewerDisplayName } from '@/lib/auth/viewer-display-name';
import { ConsentActions } from './ConsentActions';

interface ConsentPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The validated redirect_uri with `error` (+ verbatim `state`) — the same shape the authorize route's buildRedirectWithParams produces for its error redirects. */
function errorRedirectUrl(redirectUri: string, error: string, state: string | undefined): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (state) url.searchParams.set('state', state);
  return url.toString();
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

  const v3 = isV3AuthEnabled();
  const signedInAs = v3 ? await getViewerDisplayName(session.userId) : undefined;
  const frame = signedInAs ? { signedInAs } : {};

  if (!result.ok) {
    if (result.kind === 'no_redirect') {
      const message = result.error === 'invalid_client' ? 'Unknown client.' : 'Invalid or unregistered redirect_uri.';
      return (
        <AuthLayout classic="bare" {...frame}>
          {v3 ? (
            <div>
              <h1 className={V3_HEADING}>Authorization error</h1>
              <p className={V3_BODY}>{message}</p>
            </div>
          ) : (
            <div className="mx-auto max-w-md py-16 text-center">
              <h1 className="text-xl font-semibold">Authorization error</h1>
              <p className="mt-2 text-muted-foreground">{message}</p>
            </div>
          )}
        </AuthLayout>
      );
    }
    // Defense in depth: /api/oauth/authorize should already have redirected
    // this case before ever reaching the consent screen.
    redirect(errorRedirectUrl(result.redirectUri, result.error, result.state));
  }

  // An update_key grant re-scopes one of the CONSENTING user's existing keys
  // in place; an activate_key grant approves making one of them a device's
  // ambient default. Ownership (and un-revoked) is checked here so the
  // consent screen can only ever narrate the user's own key — a foreign,
  // revoked, or nonexistent token id all collapse to the same invalid_scope
  // redirect (no oracle), killing the "point a victim's consent at the
  // attacker's token" direction. The approval POST re-checks this
  // server-side; this render is the human-facing half.
  let updateKeyName: string | null = null;
  let activateKeyName: string | null = null;
  const targetKeyId = result.scopes.updateKeyId ?? result.scopes.activateKeyId;
  if (targetKeyId !== null) {
    const target = await sessionRepository.findActiveMcpTokenByIdAndUser(targetKeyId, session.userId);
    if (!target) {
      redirect(errorRedirectUrl(result.redirectUri, 'invalid_scope', result.state));
    }
    if (result.scopes.updateKeyId !== null) updateKeyName = target.name;
    else activateKeyName = target.name;
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
  // Named first so the user reads "this creates a key named X" before the
  // capability list that follows.
  if (result.scopes.newKeyName !== null) {
    scopeDescriptions.push(describeScopeForConsent({ kind: 'name', name: result.scopes.newKeyName }, {}));
  }
  if (result.scopes.updateKeyId !== null) {
    scopeDescriptions.push(
      describeScopeForConsent(
        { kind: 'update_key', tokenId: result.scopes.updateKeyId },
        { keyName: updateKeyName ?? undefined },
      ),
    );
  }
  if (result.scopes.activateKeyId !== null) {
    scopeDescriptions.push(
      describeScopeForConsent(
        { kind: 'activate_key', tokenId: result.scopes.activateKeyId },
        { keyName: activateKeyName ?? undefined },
      ),
    );
  }
  if (result.scopes.account) {
    scopeDescriptions.push(describeScopeForConsent({ kind: 'account' }, {}));
  }
  if (result.scopes.offlineAccess) {
    scopeDescriptions.push(describeScopeForConsent({ kind: 'offline_access' }, {}));
  }
  if (result.scopes.manageKeys) {
    scopeDescriptions.push(describeScopeForConsent({ kind: 'manage_keys' }, {}));
  }
  if (result.scopes.allDrives) {
    scopeDescriptions.push(describeScopeForConsent({ kind: 'all_drives' }, {}));
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

  const title =
    updateKeyName !== null
      ? `${result.client.name} wants to update the key "${updateKeyName}"`
      : activateKeyName !== null
        ? `${result.client.name} wants to make "${activateKeyName}" its active key`
        : `${result.client.name} is requesting access`;

  return (
    <AuthLayout classic="bare" {...frame}>
      <div className={v3 ? undefined : 'mx-auto max-w-md py-16'}>
        <ConsentScopeCard title={title} firstParty={result.client.firstParty} scopeDescriptions={scopeDescriptions}>
          <ConsentActions
            clientId={authorizeParams.clientId!}
            redirectUri={result.redirectUri}
            responseType={authorizeParams.responseType!}
            codeChallenge={result.codeChallenge}
            codeChallengeMethod={authorizeParams.codeChallengeMethod!}
            scope={authorizeParams.scope!}
            state={result.state}
          />
        </ConsentScopeCard>
      </div>
    </AuthLayout>
  );
}
