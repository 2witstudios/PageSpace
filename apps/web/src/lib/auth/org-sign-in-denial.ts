/**
 * Org sign-in denials on the client (D-OW-45; SEC-2/SEC-3). Pure.
 *
 * When an org's sign-in policy refuses the current credential, the API answers 403 (or 401) with
 * `code: 'org_strong_sign_in_required' | 'org_reauthentication_required'` and, where known, the `orgId`. This reads
 * that shape (trusting nothing else in the body) and words what to ask the person for. The shared fetch layer
 * (auth-fetch) hands every such response to the re-authentication prompt, so SWR reads and mutations alike surface it.
 */
import type { OrgAuthenticationDenialCode } from '@pagespace/lib/organizations/authentication-policy-core';

export type OrgSignInDenialCode = OrgAuthenticationDenialCode;

export interface OrgSignInDenial {
  readonly code: OrgSignInDenialCode;
  readonly orgId: string | null;
}

const CODES: ReadonlySet<string> = new Set<OrgSignInDenialCode>(['org_strong_sign_in_required', 'org_reauthentication_required']);

export function isOrgSignInDenialCode(value: unknown): value is OrgSignInDenialCode {
  return typeof value === 'string' && CODES.has(value);
}

/** The denial an error response carries, or null. Only 401/403 bodies with one of the two codes count. */
export function readOrgSignInDenial(status: number, body: unknown): OrgSignInDenial | null {
  if (status !== 401 && status !== 403) return null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { code, orgId } = body as Record<string, unknown>;
  if (!isOrgSignInDenialCode(code)) return null;
  return { code, orgId: typeof orgId === 'string' && orgId.length > 0 ? orgId : null };
}

/** A user-verified passkey satisfies both requirements, so strong sign-in is what to ask for when any org needs it. */
export function strongestRequirement(codes: readonly OrgSignInDenialCode[]): OrgSignInDenialCode | null {
  if (codes.includes('org_strong_sign_in_required')) return 'org_strong_sign_in_required';
  return codes.length > 0 ? 'org_reauthentication_required' : null;
}

export function describeOrgSignInRequirement(code: OrgSignInDenialCode, orgName: string | null): string {
  const who = orgName ?? 'An organization';
  return code === 'org_strong_sign_in_required'
    ? `${who} requires strong sign-in (passkey).`
    : `${who} asks you to sign in again: your sign-in is older than it allows.`;
}
