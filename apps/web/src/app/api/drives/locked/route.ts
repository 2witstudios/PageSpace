import { NextResponse } from 'next/server';
import { listAccessibleDrives } from '@pagespace/lib/services/drive-service';
import { getOrgPolicies } from '@pagespace/lib/organizations/policy-reader';
import { findOrganizationNames } from '@pagespace/lib/organizations/repository';
import { lockedOrgDrives, type OrgAuthenticationPolicy } from '@pagespace/lib/organizations/authentication-policy-core';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

/**
 * GET /api/drives/locked (D-OW-45; SEC-2/SEC-3)
 *
 * GET /api/drives leaves out the org drives an org's sign-in policy refuses to the current credential. This lists
 * them — only drives the person can otherwise reach — with their org and the code saying what unlocks them
 * (`org_strong_sign_in_required`: confirm with a passkey; `org_reauthentication_required`: sign in again), so the
 * drive list shows them as "locked — sign in again" instead of letting them vanish. Names only of drives and orgs the
 * person already belongs to. Session-only: it explains the browser session's own state.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, { allow: ['session'] as const, requireCSRF: false });
  if (isAuthError(auth)) return auth.error;
  if (!ORGS_ENABLED) return NextResponse.json({ locked: [] });

  try {
    const drives = await listAccessibleDrives(auth.userId);
    const orgIds = [...new Set(drives.flatMap((d) => (d.orgId ? [d.orgId] : [])))];
    const policies = new Map<string, OrgAuthenticationPolicy>(
      await Promise.all(orgIds.map(async (orgId) => [orgId, await getOrgPolicies(orgId)] as const)),
    );
    const locked = lockedOrgDrives({ drives, policies, authentication: auth.authentication ?? null, nowMs: Date.now() });
    const names = locked.length > 0 ? await findOrganizationNames([...new Set(locked.map((l) => l.orgId))]) : new Map<string, string>();
    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'drive', resourceId: 'locked', details: { count: locked.length } });
    return NextResponse.json(
      { locked: locked.map((l) => ({ ...l, orgName: names.get(l.orgId) ?? null })) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    loggers.api.error('Error listing sign-in-locked drives:', error as Error);
    return NextResponse.json({ error: 'Failed to list locked drives' }, { status: 500 });
  }
}
