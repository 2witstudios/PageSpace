import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getOrgPolicies, updateOrgPolicies } from '@pagespace/lib/organizations/policies';
import { validateOrgPoliciesPatch } from '@pagespace/lib/organizations/policies-core';
import { checkOrgActive } from '@pagespace/lib/organizations/status';
import { authorizeOrgRequest, ORG_READ_AUTH, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';

type Context = { params: Promise<{ orgId: string }> };

/**
 * GET /api/orgs/[orgId]/policies (Spec POL-1) — Owner and Admins read the org's policies, defaults
 * filled in. A plain member sees no org settings (UI-11): the same 403 as any Admin-only read, and a
 * non-member gets the 404 of an org that does not exist.
 */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const policies = await getOrgPolicies(orgId);
    auditRequest(request, { eventType: 'data.read', userId: gate.userId, resourceType: 'organization_policies', resourceId: orgId, details: { orgId } });
    return NextResponse.json({ policies });
  } catch (error) {
    loggers.api.error('Error reading organization policies:', error as Error);
    return NextResponse.json({ error: 'Failed to read policies' }, { status: 500 });
  }
}

const countByKind = (items: readonly { kind: string }[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of items) out[item.kind] = (out[item.kind] ?? 0) + 1;
  return out;
};

/**
 * PATCH /api/orgs/[orgId]/policies — Owner and Admins change policies. A change applies immediately;
 * anything it newly forbids is suspended, never deleted, and listed (GET .../policies/suspended and the
 * audit log). A lapsed org cannot change policies (SEAT-9). The change itself is audited in lib
 * (updateOrgPolicies writes org.policy.changed with the org dimension), not here, so it is written once.
 */
export async function PATCH(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = validateOrgPoliciesPatch(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.issues }, { status: 400 });
    }
    const active = await checkOrgActive(orgId);
    if (!active.ok) return NextResponse.json({ error: active.message, code: active.code }, { status: active.status });

    const result = await updateOrgPolicies({ orgId, actorId: gate.userId, patch: parsed.patch });
    if (!result.ok) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    return NextResponse.json({
      policies: result.policies,
      changed: result.changes.map((c) => c.key),
      suspended: countByKind(result.suspended),
      restored: countByKind(result.restored),
      auditRecorded: result.auditRecorded,
    });
  } catch (error) {
    loggers.api.error('Error updating organization policies:', error as Error);
    return NextResponse.json({ error: 'Failed to update policies' }, { status: 500 });
  }
}
