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

/**
 * The policy as an admin acting ON the org is held to: a damaged stored maximum age (which, for content, reads as the
 * strictest value and refuses everyone) is read as the strictest VALID age, so a freshly signed-in Admin can still reach
 * the settings that repair it instead of no one ever being able to. Every other value is the stored one. D-OW-53(3):
 * these are the semantics kept when lane D's policyInForce (8985a21ee) is integrated.
 */
export function policyInForce(policy: OrgAuthenticationPolicy): OrgAuthenticationPolicy {
  return normalizeMaximumSessionAgeMinutes(policy.maximumSessionAgeMinutes) === undefined
    ? { ...policy, maximumSessionAgeMinutes: MIN_MAXIMUM_SESSION_AGE_MINUTES }
    : policy;
}

/**
 * One policy for a resource several orgs govern (content derived from their drives, D-OW-62): strong sign-in if any
 * requires it, and the shortest maximum age. It refuses exactly the credentials one of `policies` refuses. Null (no
 * policy) when none governs.
 */
export function strictestAuthenticationPolicy(policies: readonly OrgAuthenticationPolicy[]): OrgAuthenticationPolicy | null {
  if (policies.length === 0) return null;
  const ages = policies.flatMap((policy) => (policy.maximumSessionAgeMinutes === null ? [] : [policy.maximumSessionAgeMinutes]));
  return {
    requireStrongSignIn: policies.some((policy) => policy.requireStrongSignIn),
    maximumSessionAgeMinutes: ages.length === 0 ? null : Math.min(...ages),
  };
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

export type SignInPolicyChangeDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: OrgAuthenticationDenialCode }
  | { readonly allowed: false; readonly code: 'org_policy_would_lock_out_actor'; readonly requires: OrgAuthenticationDenialCode };

/**
 * Who may change an org's sign-in policy, judged on the acting credential's server-verified evidence:
 *   - D-OW-45, LOOSENING (strong sign-in off, a longer or no maximum age) needs a credential that satisfies the policy
 *     in force, so a stolen or stale Admin session cannot switch the protection off and walk in. A damaged stored age
 *     (which reads as the strictest value and refuses everyone) is judged as the strictest VALID age, so a freshly
 *     signed-in Admin can repair it rather than no one ever being able to.
 *   - D-OW-47, TIGHTENING (strong sign-in on, a shorter or new maximum age) needs a credential that satisfies the
 *     RESULTING policy: the policy also governs the org's admin routes (authorizeOrgRequest asks it of every session
 *     and key after the role check), so an Admin who could not meet it would lock themselves out of the very page
 *     that sets it. `requires` names the ceremony that would let them make it.
 * A mixed change must pass both. A change that leaves the two keys as they are is not judged. Billing never enters
 * here ([D-OW-33]): a lapsed org may tighten on the same terms.
 */
export function decideSignInPolicyChange(input: {
  readonly before: OrgAuthenticationPolicy;
  readonly after: OrgAuthenticationPolicy;
  readonly authentication: VerifiedAuthentication | null;
  readonly nowMs: number;
}): SignInPolicyChangeDecision {
  const { before, after, authentication, nowMs } = input;
  if (signInPolicyLoosened(before, after)) {
    const decision = decideOrgAuthentication({ policy: policyInForce(before), authentication, nowMs });
    if (!decision.allowed) return decision;
  }
  if (signInPolicyTightened(before, after)) {
    const decision = decideOrgAuthentication({ policy: after, authentication, nowMs });
    if (!decision.allowed) return { allowed: false, code: 'org_policy_would_lock_out_actor', requires: decision.code };
  }
  return { allowed: true };
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

export interface LockedOrgDrive {
  readonly driveId: string;
  readonly driveName: string;
  readonly orgId: string;
  readonly code: OrgAuthenticationDenialCode;
}

/**
 * D-OW-45: of the drives a person can reach, the org drives their CURRENT credential is locked out of, each with the
 * code that says what would unlock it, so a drive list can show "locked — sign in again" instead of the drive
 * vanishing. An org whose policies were not supplied fails closed (needs a fresh sign-in).
 */
export function lockedOrgDrives(input: {
  readonly drives: ReadonlyArray<{ readonly id: string; readonly name: string; readonly orgId: string | null }>;
  readonly policies: ReadonlyMap<string, OrgAuthenticationPolicy>;
  readonly authentication: VerifiedAuthentication | null;
  readonly nowMs: number;
}): LockedOrgDrive[] {
  const { drives, policies, authentication, nowMs } = input;
  const locked: LockedOrgDrive[] = [];
  for (const drive of drives) {
    if (drive.orgId === null) continue;
    const policy = policies.get(drive.orgId);
    const decision: OrgAuthenticationDecision = policy
      ? decideOrgAuthentication({ policy, authentication, nowMs })
      : { allowed: false, code: 'org_reauthentication_required' };
    if (!decision.allowed) locked.push({ driveId: drive.id, driveName: drive.name, orgId: drive.orgId, code: decision.code });
  }
  return locked;
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
