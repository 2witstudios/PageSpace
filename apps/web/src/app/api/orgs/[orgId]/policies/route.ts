import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/api-error';
import { announceOrgChange } from '@pagespace/lib/organizations/org-change-events';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getOrgPolicies, updateOrgPolicies } from '@pagespace/lib/organizations/policies';
import {
  OPEN_ROLE_FLOOR_RAISE_MESSAGE,
  delegatedPolicyPatchRefusal,
  policiesForDelegatedCredential,
  validateOrgPoliciesPatch,
  type OrgPolicies,
} from '@pagespace/lib/organizations/policies-core';
import { reconcileOrgPublishedVisibility } from '@pagespace/lib/organizations/published-visibility';
import { createPublishedObjectStore, isPublishConfigured } from '@/lib/canvas/published-storage';
import { authorizeOrgRequest, ORG_TOKEN_READ_AUTH, ORG_TOKEN_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { orgLapsedResponse } from '@/lib/orgs/org-lapsed-response';

/** [D-OW-26] A delegated key reads the policies without the money keys (wallet reads are consumer-only). */
const policiesFor = (credential: 'session' | 'mcp', policies: OrgPolicies) =>
  credential === 'session' ? policies : policiesForDelegatedCredential(policies);

type Context = { params: Promise<{ orgId: string }> };

const SIGN_IN_REFUSAL = {
  org_strong_sign_in_required: 'Changing this sign-in policy needs a strong sign-in: confirm it is you with your passkey.',
  org_reauthentication_required: 'Changing this sign-in policy needs a recent sign-in: sign in again first.',
} as const;

/**
 * GET /api/orgs/[orgId]/policies (Spec POL-1) — Owner and Admins read the org's policies, defaults
 * filled in. A plain member sees no org settings (UI-11): the same 403 as any Admin-only read, and a
 * non-member gets the 404 of an org that does not exist. Session or MCP token (X-1); a drive-scoped
 * token is refused, since policies govern the whole org. A key reads them without the money keys (seat allowance,
 * wallet fallback): [D-OW-26] keeps a key to the consumer view of money.
 */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_TOKEN_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const policies = await getOrgPolicies(orgId);
    auditRequest(request, { eventType: 'data.read', userId: gate.userId, resourceType: 'organization_policies', resourceId: orgId, details: { orgId } });
    return NextResponse.json({ policies: policiesFor(gate.credential, policies) });
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
 * audit log); what it forbids that cannot be suspended is blocked where it is used and listed in the audit log. A lapsed org may only RESTRICT ([D-OW-33], amending SEAT-9: billing never blocks security):
 * lib refuses any change that loosens a policy with the lapse refusal, judged under the org row's lock. The change itself is audited in lib
 * (updateOrgPolicies writes org.policy.changed with the org dimension), not here, so it is written once.
 */
export async function PATCH(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_TOKEN_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = validateOrgPoliciesPatch(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.issues, code: 'invalid_request' }, { status: 400 });
    }
    // [D-OW-26] / D-OW-47: a key never sets a money policy (the seat allowance allocates org money, the wallet
    // fallback picks what spend draws from); the whole patch is refused before anything is stored.
    const moneyRefusal = gate.credential === 'session' ? null : delegatedPolicyPatchRefusal(parsed.patch);
    if (moneyRefusal) return apiError(403, moneyRefusal.code, moneyRefusal.message, { policy: moneyRefusal.key });
    const result = await updateOrgPolicies({ orgId, actorId: gate.userId, actorAuthentication: gate.authentication, patch: parsed.patch });
    if (!result.ok && result.reason === 'insufficient_role') return apiError(403, result.reason, 'Insufficient organization role');
    if (!result.ok && result.reason === 'org_lapsed') return orgLapsedResponse(result.message);
    if (!result.ok && (result.reason === 'org_strong_sign_in_required' || result.reason === 'org_reauthentication_required')) {
      // D-OW-45: loosening a sign-in policy needs a credential that satisfies the policy in force.
      return apiError(403, result.reason, SIGN_IN_REFUSAL[result.reason], { orgId });
    }
    if (!result.ok && result.reason === 'org_policy_would_lock_out_actor') {
      // D-OW-47: the acting Admin's own credential would not meet the tightened policy; `requires` says what would.
      return apiError(403, result.reason, 'Your own sign-in does not meet this policy, so saving it would lock you out of this organization.', { orgId, requires: result.requires });
    }
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
      policies: policiesFor(gate.credential, result.policies),
      changed: result.changes.map((c) => c.key),
      suspended: countByKind(result.suspended),
      restored: countByKind(result.restored),
      // POL-1: what it forbids but does not suspend (apps, envs, cross-drive agents, autonomy, models), by count.
      blocked: result.blocked.counts,
      // POL-1 for the sign-in keys (D-OW-45): members and credentials a tightened sign-in policy now refuses, by count.
      signInBlocked: result.signInBlocked,
      ...(publishedVisibility ? { publishedVisibility } : {}),
    });
  } catch (error) {
    loggers.api.error('Error updating organization policies:', error as Error);
    return NextResponse.json({ error: 'Failed to update policies', code: 'internal_error' }, { status: 500 });
  }
}
