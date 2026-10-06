/**
 * The shared gate for every /api/orgs route: dark behind ORGS_ENABLED, then
 * authenticate, then the ONE org authorization function requireOrgRole (Spec
 * ORG-5). A denial is audited here; route files audit what they do.
 */
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/api-error';
import { authenticateRequestWithOptions, isAuthError, getAllowedDriveIds, type AuthResult } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { requireOrgRole } from '@pagespace/lib/organizations/authorize';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import type { OrgRole } from '@pagespace/db/schema/organizations';

// Writes stay session-only. READS admit an MCP token where the CLI/MCP mirror exists
// (Spec X-1); OAuth access tokens are not admitted (the wallets routes' same posture).
// The routes the token reads serve are exactly the five behind ORG_TOKEN_READ_AUTH;
// every other org read (audit, domains, invitations, pool, seat-caps, …) stays
// session-only until its own parity work.
export const ORG_READ_AUTH = { allow: ['session'] as const, requireCSRF: false };
export const ORG_TOKEN_READ_AUTH = { allow: ['session', 'mcp'] as const, requireCSRF: false };
export const ORG_WRITE_AUTH = { allow: ['session'] as const, requireCSRF: true };

type AuthOptions = typeof ORG_READ_AUTH | typeof ORG_TOKEN_READ_AUTH | typeof ORG_WRITE_AUTH;

export type OrgGate =
  /** `role` is the caller's org role, set by authorizeOrgRequest (not by authenticateOrgRequest).
   * `allowedDriveIds` is the token's drive restriction — empty for a session or an unscoped
   * token (full access), non-empty for a drive-scoped one. */
  | { ok: true; userId: string; role?: OrgRole; allowedDriveIds: string[] }
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

/** Dark check and authentication, for routes that have no org yet (create, list, accept). */
export async function authenticateOrgRequest(request: Request, options: AuthOptions): Promise<OrgGate> {
  if (!ORGS_ENABLED) return { ok: false, response: orgsDisabledResponse() };
  const auth = await authenticateRequestWithOptions(request, options);
  if (isAuthError(auth)) return { ok: false, response: auth.error };
  return { ok: true, userId: auth.userId, allowedDriveIds: tokenAllowedDriveIds(auth) };
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

/**
 * Org reads are ORG-WIDE, so a key scoped to specific drives is refused outside the one
 * filtered surface (the drive directory) — the `wallets.list` rule for account-wide reads.
 * Null when the caller may proceed.
 */
export function refuseDriveScopedToken(gate: OrgGate): Response | null {
  if (gate.ok && gate.allowedDriveIds.length > 0) {
    return apiError(403, 'token_scope_refused', 'This token is limited to specific drives and cannot read organization-wide data');
  }
  return null;
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
  return { ok: true, userId: gate.userId, role: decision.role, allowedDriveIds: gate.allowedDriveIds };
}
