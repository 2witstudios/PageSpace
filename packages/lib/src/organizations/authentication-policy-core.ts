import { parseVerifiedAuthentication, type VerifiedAuthentication } from '../auth/authentication-evidence';
/** SEC-2/3: pure decisions over credential-bound, server-verified authentication. */
export interface OrgAuthenticationPolicy {
  readonly requireStrongSignIn: boolean;
  readonly maximumSessionAgeMinutes: number | null;
}


export type OrgAuthenticationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: 'org_strong_sign_in_required' | 'org_reauthentication_required' };

export function normalizeMaximumSessionAgeMinutes(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 15 && raw <= 43_200 ? raw : undefined;
}

export function decideOrgAuthentication(input: {
  readonly policy: OrgAuthenticationPolicy;
  readonly authentication: VerifiedAuthentication | null;
  readonly nowMs: number;
}): OrgAuthenticationDecision {
  const { policy, authentication, nowMs } = input;
  if (!policy.requireStrongSignIn && policy.maximumSessionAgeMinutes === null) return { allowed: true };
  if (policy.requireStrongSignIn && authentication?.assurance !== 'user_verified_passkey') {
    return { allowed: false, code: 'org_strong_sign_in_required' };
  }
  const verified = parseVerifiedAuthentication(authentication, nowMs);
  if (!verified) {
    return { allowed: false, code: 'org_reauthentication_required' };
  }
  const maximumAge = normalizeMaximumSessionAgeMinutes(policy.maximumSessionAgeMinutes);
  if (maximumAge === undefined || (maximumAge !== null && nowMs - verified.authenticatedAtMs >= maximumAge * 60_000)) {
    return { allowed: false, code: 'org_reauthentication_required' };
  }
  return { allowed: true };
}
