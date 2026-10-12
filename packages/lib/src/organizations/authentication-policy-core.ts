import { parseVerifiedAuthentication, type VerifiedAuthentication } from '../auth/authentication-evidence';
/** SEC-2/3: pure decisions over credential-bound, server-verified authentication. */
export interface OrgAuthenticationPolicy {
  readonly requireStrongSignIn: boolean;
  readonly maximumSessionAgeMinutes: number | null;
}

export type OrgAuthenticationDenialCode = 'org_strong_sign_in_required' | 'org_reauthentication_required';

export type OrgAuthenticationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: OrgAuthenticationDenialCode };

/** The allowed maximum-age range in whole minutes: 15 minutes to 30 days. */
export const MIN_MAXIMUM_SESSION_AGE_MINUTES = 15;
export const MAX_MAXIMUM_SESSION_AGE_MINUTES = 43_200;

export function normalizeMaximumSessionAgeMinutes(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_MAXIMUM_SESSION_AGE_MINUTES && raw <= MAX_MAXIMUM_SESSION_AGE_MINUTES
    ? raw
    : undefined;
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

/** [D-OW-33] Per key: does `after` admit no credential that `before` refused? Equal values are not looser. */
export const requireStrongSignInNoLooser = (before: boolean, after: boolean): boolean => !before || after;
export const maximumSessionAgeNoLooser = (before: number | null, after: number | null): boolean =>
  before === null || (after !== null && after <= before);

/** Does the change admit a credential the policy in force refuses? */
export function signInPolicyLoosened(before: OrgAuthenticationPolicy, after: OrgAuthenticationPolicy): boolean {
  return !requireStrongSignInNoLooser(before.requireStrongSignIn, after.requireStrongSignIn) ||
    !maximumSessionAgeNoLooser(before.maximumSessionAgeMinutes, after.maximumSessionAgeMinutes);
}

/** Does the change refuse a credential the policy in force admits? (A mixed change is both.) */
export function signInPolicyTightened(before: OrgAuthenticationPolicy, after: OrgAuthenticationPolicy): boolean {
  return signInPolicyLoosened(after, before);
}

/**
 * D-OW-45: loosening a sign-in policy (strong sign-in off, a longer or no maximum age) needs the acting credential to
 * satisfy the policy currently in force, so a stolen or stale Admin session cannot switch the protection off and walk
 * in. Tightening is always allowed ([D-OW-33]: billing never blocks security, and neither does a stale credential).
 * A damaged stored age (which reads as the strictest value and refuses everyone) is judged as the strictest VALID
 * age, so a freshly signed-in Admin can repair it rather than no one ever being able to.
 */
export function decideSignInPolicyChange(input: {
  readonly before: OrgAuthenticationPolicy;
  readonly after: OrgAuthenticationPolicy;
  readonly authentication: VerifiedAuthentication | null;
  readonly nowMs: number;
}): OrgAuthenticationDecision {
  const { before, after, authentication, nowMs } = input;
  if (!signInPolicyLoosened(before, after)) return { allowed: true };
  const maximumAge = normalizeMaximumSessionAgeMinutes(before.maximumSessionAgeMinutes);
  const inForce = { ...before, maximumSessionAgeMinutes: maximumAge === undefined ? MIN_MAXIMUM_SESSION_AGE_MINUTES : maximumAge };
  return decideOrgAuthentication({ policy: inForce, authentication, nowMs });
}

export type ReauthenticationDecision =
  | { readonly ok: true; readonly authentication: VerifiedAuthentication }
  | { readonly ok: false; readonly reason: 'weaker_than_current' };

/**
 * D-OW-45: a fresh, server-verified ceremony replaces the evidence on the credential that ran it. It never lowers the
 * assurance: an emailed link does not overwrite a user-verified passkey, or re-authenticating for one org's maximum
 * age would lock the person out of another org that requires strong sign-in.
 */
export function decideReauthentication(input: {
  readonly current: VerifiedAuthentication | null;
  readonly fresh: VerifiedAuthentication;
}): ReauthenticationDecision {
  const { current, fresh } = input;
  if (current?.assurance === 'user_verified_passkey' && fresh.assurance !== 'user_verified_passkey') {
    return { ok: false, reason: 'weaker_than_current' };
  }
  return { ok: true, authentication: fresh };
}

/**
 * POL-1 for the sign-in keys: how many live credentials a policy refuses, and how many people hold no live credential
 * it admits (they must sign in again before opening the org's drives). Counts only, no identities.
 */
export function countSignInBlocked(input: {
  readonly policy: OrgAuthenticationPolicy;
  readonly credentials: ReadonlyArray<{ readonly userId: string; readonly authentication: VerifiedAuthentication | null }>;
  readonly nowMs: number;
}): { readonly members: number; readonly credentials: number } {
  const { policy, credentials, nowMs } = input;
  const admitted = new Set<string>();
  const refused = new Set<string>();
  let refusedCredentials = 0;
  for (const credential of credentials) {
    if (decideOrgAuthentication({ policy, authentication: credential.authentication, nowMs }).allowed) {
      admitted.add(credential.userId);
    } else {
      refused.add(credential.userId);
      refusedCredentials += 1;
    }
  }
  const members = [...refused].filter((userId) => !admitted.has(userId)).length;
  return { members, credentials: refusedCredentials };
}
