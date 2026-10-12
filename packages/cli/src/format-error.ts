/**
 * How the CLI prints a failed call. PURE. The server's own message first; then, when an organization's sign-in policy
 * refused the credential (D-OW-45), what to do about it — the API answers a stable code for exactly this.
 */
import { orgSignInRequirementOf, type OrgSignInRequirement } from '@pagespace/sdk';

export const ORG_SIGN_IN_HINTS: Readonly<Record<OrgSignInRequirement, string>> = {
  org_strong_sign_in_required:
    'This organization requires strong sign-in. Run "pagespace login" and sign in with a passkey (fingerprint, face or PIN), then try again.',
  org_reauthentication_required:
    'This organization requires a recent sign-in. Run "pagespace login" again, then try again.',
};

export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const requirement = orgSignInRequirementOf(error);
  return requirement ? `${message}\n${ORG_SIGN_IN_HINTS[requirement]}` : message;
}
