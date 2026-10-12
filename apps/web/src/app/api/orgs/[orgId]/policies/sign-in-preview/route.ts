import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { normalizeMaximumSessionAgeMinutes } from '@pagespace/lib/organizations/authentication-policy-core';
import { countOrgSignInBlocked } from '@pagespace/lib/organizations/sign-in-blocked';
import { apiError } from '@/lib/api/api-error';
import { authorizeOrgRequest, ORG_TOKEN_READ_AUTH } from '@/lib/orgs/org-route-auth';

type Context = { params: Promise<{ orgId: string }> };

/**
 * GET /api/orgs/[orgId]/policies/sign-in-preview?requireStrongSignIn=true&maximumSessionAgeMinutes=60 (D-OW-45, UI-7)
 *
 * Before an Owner or Admin saves a sign-in policy, how many of the org's members (and their live credentials) it would
 * refuse right now. Counts only, no identities. Owner and Admin only: a plain member gets the 403 of any Admin read.
 * Session or MCP key (X-1: `organizations.previewSignInPolicy`, `pagespace orgs sign-in-preview`), like the policies it previews. `maximumSessionAgeMinutes` is a whole number of minutes in the allowed range, or omitted for none.
 */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_TOKEN_READ_AUTH);
  if (!gate.ok) return gate.response;

  const params = new URL(request.url).searchParams;
  const strong = params.get('requireStrongSignIn');
  const rawAge = params.get('maximumSessionAgeMinutes');
  const maximumSessionAgeMinutes = rawAge === null || rawAge === '' ? null : normalizeMaximumSessionAgeMinutes(Number(rawAge));
  if ((strong !== null && strong !== 'true' && strong !== 'false') || maximumSessionAgeMinutes === undefined) {
    return apiError(400, 'invalid_request', 'requireStrongSignIn must be true or false and maximumSessionAgeMinutes a whole number from 15 to 43200');
  }

  try {
    const counts = await countOrgSignInBlocked(db, orgId, { requireStrongSignIn: strong === 'true', maximumSessionAgeMinutes });
    auditRequest(request, { eventType: 'data.read', userId: gate.userId, resourceType: 'organization_policies', resourceId: orgId, details: { orgId, preview: 'sign_in' } });
    return NextResponse.json(counts);
  } catch (error) {
    loggers.api.error('Error previewing an organization sign-in policy:', error as Error);
    return apiError(500, 'internal_error', 'Failed to preview the sign-in policy');
  }
}
