import { NextResponse } from 'next/server';
import { announceOrgChange } from '@pagespace/lib/organizations/org-change-events';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getOrgPolicies, updateOrgPolicies } from '@pagespace/lib/organizations/policies';
import { OPEN_ROLE_FLOOR_RAISE_MESSAGE, validateOrgPoliciesPatch } from '@pagespace/lib/organizations/policies-core';
import { checkOrgActive } from '@pagespace/lib/organizations/status';
import { reconcileOrgPublishedVisibility } from '@pagespace/lib/organizations/published-visibility';
import { createPublishedObjectStore, isPublishConfigured } from '@/lib/canvas/published-storage';
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
    return NextResponse.json({ error: 'Failed to read policies', code: 'internal_error' }, { status: 500 });
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
 * audit log); what it forbids that cannot be suspended is blocked where it is used and listed in the audit log. A lapsed org cannot change policies (SEAT-9). The change itself is audited in lib
 * (updateOrgPolicies writes org.policy.changed with the org dimension), not here, so it is written once.
 */
export async function PATCH(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = validateOrgPoliciesPatch(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.issues, code: 'invalid_request' }, { status: 400 });
    }
    const active = await checkOrgActive(orgId);
    if (!active.ok) return NextResponse.json({ error: active.message, code: active.code }, { status: active.status });

    const result = await updateOrgPolicies({ orgId, actorId: gate.userId, patch: parsed.patch });
    if (!result.ok && result.reason === 'open_role_floor') {
      return NextResponse.json({ error: OPEN_ROLE_FLOOR_RAISE_MESSAGE, code: 'org_policy', policy: 'openDriveRoleFloor', drives: result.drives }, { status: 403 });
    }
    if (!result.ok) return NextResponse.json({ error: 'Organization not found', code: 'org_not_found' }, { status: 404 });

    // POL-4: published sites live in a public bucket the edge serves without asking the database, so a change to
    // publishing or domains takes effect by MOVING the objects (park or restore), not by a marker. A failure here
    // never undoes the policy: it is reported, and the reconcile sweep retries it.
    let publishedVisibility: { parked: number; restored: number; failed: number } | null = null;
    if (result.changes.some((c) => c.key === 'publishWeb' || c.key === 'customDomains') && isPublishConfigured()) {
      try {
        const outcomes = await reconcileOrgPublishedVisibility(orgId, createPublishedObjectStore());
        const n = (action: string) => outcomes.filter((o) => o.action === action).length;
        publishedVisibility = { parked: n('parked'), restored: n('restored'), failed: n('failed') };
      } catch (error) {
        loggers.api.error('Published visibility reconcile failed after a policy change:', error as Error);
        publishedVisibility = { parked: 0, restored: 0, failed: -1 };
      }
    }
    // X-4: members see the change without a refresh (org:changed, no content).
    void announceOrgChange(orgId, 'policy');
    return NextResponse.json({
      policies: result.policies,
      changed: result.changes.map((c) => c.key),
      suspended: countByKind(result.suspended),
      restored: countByKind(result.restored),
      // POL-1: what it forbids but does not suspend (apps, envs, cross-drive agents, autonomy, models), by count.
      blocked: result.blocked.counts,
      auditRecorded: result.auditRecorded,
      ...(publishedVisibility ? { publishedVisibility } : {}),
    });
  } catch (error) {
    loggers.api.error('Error updating organization policies:', error as Error);
    return NextResponse.json({ error: 'Failed to update policies', code: 'internal_error' }, { status: 500 });
  }
}
