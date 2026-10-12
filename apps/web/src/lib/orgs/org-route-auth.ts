/**
 * The shared gate for every org route (/api/orgs/**, the drive-org routes, join requests): dark
 * behind ORGS_ENABLED, then authenticate, then the ONE org authorization function requireOrgRole
 * (Spec ORG-5), then the org's sign-in policy on the credential (SEC-2/3). A denial is audited
 * here; route files audit what they do.
 */
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/api-error';
import { authenticateRequestWithOptions, isAuthError, getAllowedDriveIds, type AuthResult } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { requireOrgRole } from '@pagespace/lib/organizations/authorize';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { checkOrgAuthentication, drivePolicyOrgId } from '@pagespace/lib/organizations/authentication-policy';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';
import type { OrgRole } from '@pagespace/db/schema/organizations';

// Credential postures (Spec X-1, [D-OW-26]). TOKEN options admit a session or an MCP key — the
// CLI and MCP mirror every org route that is not a money move. MONEY options are the money moves
// (card-checkout create, org delete — it ends the subscription —, ownership transfer, seat caps,
// billing writes): they admit an MCP key only to refuse it by name (`mcp_token_cannot_move_money`),
// as the wallet writes do. The admin money views (pool, seat caps, invoices, seats) stay session-only
// reads: a key reads wallet views only through the consumer allowlist. OAuth access tokens are not
// admitted (the wallets routes' same posture).
//
// A key scoped to specific drives is refused on every org route (org data and org authority are
// wider than any drive scope), except the one filtered surface — the org drive directory, which
// shows a scoped key only the drives its scope already covers.
export const ORG_READ_AUTH = { allow: ['session'] as const, requireCSRF: false };
export const ORG_TOKEN_READ_AUTH = { allow: ['session', 'mcp'] as const, requireCSRF: false };
export const ORG_TOKEN_WRITE_AUTH = { allow: ['session', 'mcp'] as const, requireCSRF: true };
export const ORG_TOKEN_DIRECTORY_AUTH = { allow: ['session', 'mcp'] as const, requireCSRF: false, driveScopedTokens: 'filter' as const };
export const ORG_MONEY_WRITE_AUTH = { allow: ['session', 'mcp'] as const, requireCSRF: true, delegatedCredentials: 'refuse_money_move' as const };

type OrgAuthenticationDecision = Awaited<ReturnType<typeof checkOrgAuthentication>>;

type AuthOptions =
  | typeof ORG_READ_AUTH
  | typeof ORG_TOKEN_READ_AUTH
  | typeof ORG_TOKEN_WRITE_AUTH
  | typeof ORG_TOKEN_DIRECTORY_AUTH
  | typeof ORG_MONEY_WRITE_AUTH;

export type OrgGate =
  /** `role` is the caller's org role, set by authorizeOrgRequest (not by authenticateOrgRequest).
   * `allowedDriveIds` is the token's drive restriction — empty for a session or an unscoped
   * token (full access); non-empty only on the directory, the one route that filters by it.
   * `authentication` is the credential's verified sign-in evidence, for the org sign-in policy.
   * `credential` is how the caller authenticated: a delegated key ('mcp') never moves money ([D-OW-26]). */
  | { ok: true; userId: string; role?: OrgRole; allowedDriveIds: string[]; authentication: VerifiedAuthentication | null; credential: 'session' | 'mcp' }
  | { ok: false; response: Response };

/** 404 exactly as an unknown route would answer, so dark orgs reveal nothing. */
export const orgsDisabledResponse = (): Response => NextResponse.json({ error: 'Not found' }, { status: 404 });

/**
 * Billing is off on this deployment (onprem, tenant): the org exists but has no plan, seats or
 * subscription. Distinguishable from orgs being dark by its code, and only answered to a caller
 * the org gate already admitted, so it reveals nothing to an outsider.
 */
export const billingUnavailableResponse = (): Response =>
  apiError(404, 'billing_unavailable', 'Organization billing is not available on this deployment');

/**
 * Dark check and authentication, for routes that have no org yet (create, list, accept) or whose
 * org is a drive's (join requests, the drive-org routes — their services ask requireOrgRole).
 */
export async function authenticateOrgRequest(request: Request, options: AuthOptions): Promise<OrgGate> {
  if (!ORGS_ENABLED) return { ok: false, response: orgsDisabledResponse() };
  const { allow, requireCSRF } = options;
  const auth = await authenticateRequestWithOptions(request, { allow, requireCSRF });
  if (isAuthError(auth)) return { ok: false, response: auth.error };
  if ('delegatedCredentials' in options && auth.tokenType !== 'session') {
    return {
      ok: false,
      response: apiError(403, 'mcp_token_cannot_move_money', 'An access token cannot move money or hand over who controls it (billing, seat caps, ownership); sign in to do this'),
    };
  }
  const allowedDriveIds = tokenAllowedDriveIds(auth);
  if (allowedDriveIds.length > 0 && !('driveScopedTokens' in options)) {
    return {
      ok: false,
      response: apiError(403, 'token_scope_refused', 'This token is limited to specific drives and cannot act on organization-wide data'),
    };
  }
  return {
    ok: true,
    userId: auth.userId,
    allowedDriveIds,
    authentication: auth.authentication ?? null,
    credential: auth.tokenType === 'session' ? 'session' : 'mcp',
  };
}

/** The credential's drive restriction; empty = unrestricted (a session or an unscoped token). */
function tokenAllowedDriveIds(auth: AuthResult): string[] {
  switch (auth.tokenType) {
    case 'mcp':
      return getAllowedDriveIds(auth);
    case 'session':
      return [];
    default: {
      // Not admitted by any org auth options today; fails closed if that ever changes.
      return ['__credential_type_not_admitted__'];
    }
  }
}

const SIGN_IN_POLICY_MESSAGES: Record<Extract<OrgAuthenticationDecision, { allowed: false }>['code'], string> = {
  org_strong_sign_in_required: 'This organization requires signing in with a passkey',
  org_reauthentication_required: 'This organization requires a recent sign-in',
};

function signInPolicyRefusal(
  request: Request,
  gate: Extract<OrgGate, { ok: true }>,
  decision: OrgAuthenticationDecision,
  resource: { resourceType: 'organization'; resourceId: string },
): Response | null {
  if (decision.allowed) return null;
  auditRequest(request, {
    eventType: 'authz.access.denied',
    userId: gate.userId,
    ...resource,
    details: { reason: decision.code },
  });
  return apiError(403, decision.code, SIGN_IN_POLICY_MESSAGES[decision.code]);
}

async function orgCredentialRefusal(request: Request, gate: Extract<OrgGate, { ok: true }>, orgId: string): Promise<Response | null> {
  return signInPolicyRefusal(request, gate, await checkOrgAuthentication(orgId, gate.authentication), { resourceType: 'organization', resourceId: orgId });
}

/**
 * The sign-in policy of `orgId` against the gate's credential, for a route whose org comes from its
 * body (a drive moved or created into an org). A refusal is answered only to a member of that org —
 * membership through the one org authorization function — so nobody learns another org's policy by
 * naming it; a non-member proceeds to the service, which refuses them. Null when the caller may proceed.
 */
export async function refuseOrgCredential(request: Request, gate: Extract<OrgGate, { ok: true }>, orgId: string): Promise<Response | null> {
  const decision = await checkOrgAuthentication(orgId, gate.authentication);
  if (decision.allowed) return null;
  const member = await requireOrgRole(gate.userId, orgId, 'MEMBER', { findMembershipRole });
  return member.ok ? signInPolicyRefusal(request, gate, decision, { resourceType: 'organization', resourceId: orgId }) : null;
}

/**
 * The sign-in policy of the org that owns `driveId` (none for a personal or missing drive), answered
 * exactly as refuseOrgCredential answers: every drive-org mutation and join request needs org
 * membership, so a non-member is left to the service's refusal. Null when it may proceed.
 */
export async function refuseDriveCredential(request: Request, gate: Extract<OrgGate, { ok: true }>, driveId: string): Promise<Response | null> {
  const orgId = await drivePolicyOrgId(driveId);
  return orgId === null ? null : refuseOrgCredential(request, gate, orgId);
}

export async function authorizeOrgRequest(
  request: Request,
  orgId: string,
  minRole: OrgRole,
  options: AuthOptions,
): Promise<OrgGate> {
  const gate = await authenticateOrgRequest(request, options);
  if (!gate.ok) return gate;
  // The lookup is passed explicitly rather than left to requireOrgRole's default, so the
  // gate's IO is visible at this seam (and a test fakes it by its package specifier; the
  // built lib's internal relative import could never be intercepted).
  const decision = await requireOrgRole(gate.userId, orgId, minRole, { findMembershipRole });
  if (!decision.ok) {
    const error = decision.status === 404 ? 'Organization not found' : 'Insufficient organization role';
    const code = decision.status === 404 ? 'org_not_found' as const : 'insufficient_role' as const;
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { reason: decision.reason, minRole },
    });
    return { ok: false, response: apiError(decision.status, code, error) };
  }
  // Role first: a non-member learns nothing about the org's sign-in policy.
  const refused = await orgCredentialRefusal(request, gate, orgId);
  if (refused) return { ok: false, response: refused };
  return { ...gate, role: decision.role };
}
