/**
 * How the CLI prints a failed call. PURE. The server's own message first; then, when an organization's sign-in policy
 * refused the credential (D-OW-45), what to do about it — the API answers a stable code for exactly this. The fix
 * depends on the credential: a login is renewed by signing in again, but a scoped access key carries the sign-in it was
 * created from for life, so signing in again changes nothing for it — only a new key, created from a sign-in that meets
 * the policy, does.
 */
import { orgSignInRequirementOf, type OrgSignInRequirement } from '@pagespace/sdk';
import type { CredentialKind } from './auth/credential-kind.js';

export const ORG_SIGN_IN_HINTS: Readonly<Record<OrgSignInRequirement, string>> = {
  org_strong_sign_in_required:
    'This organization requires strong sign-in. Run "pagespace login" and sign in with a passkey (fingerprint, face or PIN), then try again.',
  org_reauthentication_required:
    'This organization requires a recent sign-in. Run "pagespace login" again, then try again.',
};

/** For a scoped access key (mcp_*): signing in again does not change the key, so the fix is a new one. */
export const ORG_SIGN_IN_KEY_HINTS: Readonly<Record<OrgSignInRequirement, string>> = {
  org_strong_sign_in_required:
    'This organization requires strong sign-in, and this access key was created from a sign-in without a passkey. ' +
    'Create a new key while signed in with a passkey (fingerprint, face or PIN), then use the new key.',
  org_reauthentication_required:
    'This organization requires a recent sign-in, and this access key was created from a sign-in that is now too old. ' +
    'Create a new key from a fresh sign-in, then use the new key.',
};

/** The hint for a sign-in denial, for the credential that was refused (unknown: a login's). */
export function orgSignInHint(requirement: OrgSignInRequirement, credentialKind?: CredentialKind): string {
  return credentialKind === 'key' ? ORG_SIGN_IN_KEY_HINTS[requirement] : ORG_SIGN_IN_HINTS[requirement];
}

export function formatCliError(error: unknown, credentialKind?: CredentialKind): string {
  const message = error instanceof Error ? error.message : String(error);
  const requirement = orgSignInRequirementOf(error);
  return requirement ? `${message}\n${orgSignInHint(requirement, credentialKind)}` : message;
}
