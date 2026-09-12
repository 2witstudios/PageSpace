/**
 * A local environment's ACTIVITY — `GET /api/drives/[driveId]/envs/[envId]/activity`
 * (GA wave 3, leaf 2). The server side of the grant audit
 * (`drive_env_grant_audit`), newest first: what is running on the machine
 * right now (`verdict: 'signed'`, `resultAt: null`) and what ran.
 *
 * **Owner only, by the row ([D-6], invariant 13).** The reader must be
 * `drive_env_local.ownerId`. Every row names a COMMAND the owner's agent ran
 * on the owner's own computer; a drive admin who did not enrol the machine is
 * 403 (`not_owner`), audited, and told who the owner is — Delete and Revoke
 * stay with admins, seeing what ran does not. No drive role is consulted.
 *
 * `driveId` is checked against the row, not trusted from the path (the same
 * rule as the sibling routes): a mismatch answers 404.
 *
 * Every read is audited (`data.read` on the env).
 */
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, isPrincipalDriveMember } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { GRANT_AUDIT_LIST_LIMIT } from '@pagespace/lib/services/drive-envs/grant-audit-store';
import { getDriveEnvStore, listEnvActivity, resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };

export async function GET(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
  try {
    const { driveId, envId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveMember(auth, driveId))) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'drive', resourceId: driveId, details: { route: 'drive-env-activity', operation: 'read', envId } });
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }

    const env = await resolveEnvInDrive(envId, driveId);
    if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    if (env.substrate !== 'local') return NextResponse.json({ error: 'Only a local environment has machine activity', reason: 'not_local' }, { status: 409 });

    const sibling = await (await getDriveEnvStore()).findLocalByEnvId(envId);
    if (!sibling) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });

    // The OWNER only (D-6): what ran on a person's laptop is theirs to see.
    if (sibling.ownerId !== auth.userId) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'drive_env', resourceId: envId, details: { route: 'drive-env-activity', operation: 'read', ownerId: sibling.ownerId }, riskScore: 0.3 });
      return NextResponse.json(
        { error: `Only this machine's owner (the user who enrolled it, ${sibling.ownerId}) can see what ran on it — drive admins can delete or revoke it, but not drive it`, reason: 'not_owner', ownerId: sibling.ownerId },
        { status: 403 },
      );
    }

    const activity = await listEnvActivity({ envId, limit: GRANT_AUDIT_LIST_LIMIT });
    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'drive_env', resourceId: envId, details: { route: 'drive-env-activity', operation: 'read', driveId, rows: activity.length } });
    return NextResponse.json({ activity });
  } catch (error) {
    loggers.api.error('Failed to read environment activity', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to read environment activity' }, { status: 500 });
  }
}
