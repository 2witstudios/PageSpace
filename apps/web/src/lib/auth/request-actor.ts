/**
 * The web adapter between a request's credential and the permission layer's AccessActor (D-OW-45), and the one
 * response every route gives when an org's sign-in policy (SEC-2/SEC-3) is what refused it.
 */
import { NextResponse } from 'next/server';
import { credentialActor, type AccessActor, type OrgAuthenticationDenialCode } from '@pagespace/lib/permissions/access-actor';
import { explainSignInRefusal } from '@pagespace/lib/permissions/permissions';
import type { AuthResult } from './index';
import type { VerifiedUser } from './auth';

/**
 * The request's credential as an actor: its user and the ceremony evidence bound to the credential (a session,
 * device, MCP or OAuth token, or a dispatched worker carrying its dispatcher's). Every lib access function asks the
 * org sign-in policy of it.
 */
export function actorFromAuth(auth: Pick<AuthResult, 'userId' | 'authentication'>): AccessActor {
  return credentialActor(auth.userId, auth.authentication);
}

/** actorFromAuth for the session-only `verifyAuth` result. */
export function actorFromVerifiedUser(user: Pick<VerifiedUser, 'id' | 'authentication'>): AccessActor {
  return credentialActor(user.id, user.authentication);
}

const DENIAL_MESSAGES: Record<OrgAuthenticationDenialCode, string> = {
  org_strong_sign_in_required: 'This organization requires you to sign in with a passkey to open its content.',
  org_reauthentication_required: 'Sign in again to open this organization’s content.',
};

/** 403 `{ error, code }` for a sign-in policy refusal: the code a client keys its re-authentication prompt on. */
export function orgSignInRequiredResponse(code: OrgAuthenticationDenialCode): NextResponse {
  return NextResponse.json({ error: DENIAL_MESSAGES[code], code }, { status: 403 });
}

/**
 * After an access check refused `actor` on a page or drive: the sign-in-required response when the org's sign-in
 * policy is why, else `fallback` (the route's own 403/404). Never widens anything: it only names a refusal. A
 * resource with no page or drive (null) has no org to name, so the fallback stands.
 */
export async function deniedResponse(
  actor: AccessActor,
  resourceId: string | null | undefined,
  fallback: NextResponse,
): Promise<NextResponse> {
  if (!resourceId) return fallback;
  const code = await explainSignInRefusal(actor, resourceId);
  return code ? orgSignInRequiredResponse(code) : fallback;
}
