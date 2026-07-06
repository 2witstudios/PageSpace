/**
 * GET /api/account/oauth-grants (Phase 8 task k58h61obmc91sn1ndngrsev5).
 *
 * Session-authenticated visibility into every OAuth-authorized client
 * (including the `pagespace` CLI) currently holding a grant on this
 * account — the read half of the connected-apps settings surface. Revoking
 * is a separate route, `[grantId]/route.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { driveRoles } from '@pagespace/db/schema/members';
import { parseScopeList } from '@pagespace/lib/auth/oauth/scopes';
import { describeGrantScopes, type GrantScopeNameResolvers } from '@pagespace/lib/auth/oauth/grant-scope-summary';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { listActiveOAuthGrantsForUser, type ActiveOAuthGrantRow } from '@/lib/repositories/oauth-repository';
import { sessionRepository } from '@/lib/repositories/session-repository';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

async function resolveScopeNames(grants: ActiveOAuthGrantRow[]): Promise<GrantScopeNameResolvers> {
  const driveIds = new Set<string>();
  const customRoleIds = new Set<string>();

  for (const grant of grants) {
    const parsed = parseScopeList(grant.scopes.join(' '));
    if (!parsed.ok) continue;
    for (const scope of parsed.scopes.drives.values()) {
      driveIds.add(scope.driveId);
      if (scope.role.kind === 'custom') customRoleIds.add(scope.role.customRoleId);
    }
  }

  const drives = driveIds.size > 0 ? await sessionRepository.findDrivesByIds([...driveIds]) : [];
  const driveNamesById = new Map(drives.map((d) => [d.id, d.name]));

  const roleRows =
    customRoleIds.size > 0
      ? await Promise.all([...customRoleIds].map((id) => db.query.driveRoles.findFirst({ where: eq(driveRoles.id, id) })))
      : [];
  const roleNamesById = new Map(
    roleRows
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => [r.id, { name: r.name, description: r.description ?? null }]),
  );

  return { driveNamesById, roleNamesById };
}

export async function GET(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    const grants = await listActiveOAuthGrantsForUser(userId);
    const resolvers = await resolveScopeNames(grants);

    const response = grants.map((grant) => ({
      id: grant.id,
      clientName: grant.clientName,
      scopeDescriptions: describeGrantScopes(grant.scopes, resolvers),
      createdAt: grant.createdAt,
    }));

    auditRequest(req, { eventType: 'data.read', userId, resourceType: 'oauth_grant', resourceId: userId });
    return NextResponse.json(response);
  } catch (error) {
    loggers.auth.error('Error listing OAuth grants:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch connected apps' }, { status: 500 });
  }
}
