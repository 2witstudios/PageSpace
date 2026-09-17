/**
 * The shared gate for every /api/orgs route: dark behind ORGS_ENABLED, then
 * authenticate, then the ONE org authorization function requireOrgRole (Spec
 * ORG-5). A denial is audited here; route files audit what they do.
 */
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { requireOrgRole } from '@pagespace/lib/organizations/authorize';
import type { OrgRole } from '@pagespace/db/schema/organizations';

// Session only: CLI and MCP parity is Wave G (Spec X-1).
export const ORG_READ_AUTH = { allow: ['session'] as const, requireCSRF: false };
export const ORG_WRITE_AUTH = { allow: ['session'] as const, requireCSRF: true };

type AuthOptions = typeof ORG_READ_AUTH | typeof ORG_WRITE_AUTH;

export type OrgGate =
  | { ok: true; userId: string }
  | { ok: false; response: Response };

/** 404 exactly as an unknown route would answer, so dark orgs reveal nothing. */
export const orgsDisabledResponse = (): Response => NextResponse.json({ error: 'Not found' }, { status: 404 });

/** Dark check and authentication, for routes that have no org yet (create, list, accept). */
export async function authenticateOrgRequest(request: Request, options: AuthOptions): Promise<OrgGate> {
  if (!ORGS_ENABLED) return { ok: false, response: orgsDisabledResponse() };
  const auth = await authenticateRequestWithOptions(request, options);
  if (isAuthError(auth)) return { ok: false, response: auth.error };
  return { ok: true, userId: auth.userId };
}

export async function authorizeOrgRequest(
  request: Request,
  orgId: string,
  minRole: OrgRole,
  options: AuthOptions,
): Promise<OrgGate> {
  const gate = await authenticateOrgRequest(request, options);
  if (!gate.ok) return gate;
  const decision = await requireOrgRole(gate.userId, orgId, minRole);
  if (!decision.ok) {
    const error = decision.status === 404 ? 'Organization not found' : 'Insufficient organization role';
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { reason: decision.reason, minRole },
    });
    return { ok: false, response: NextResponse.json({ error }, { status: decision.status }) };
  }
  return { ok: true, userId: gate.userId };
}
