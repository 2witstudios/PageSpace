/**
 * A local environment's durable approvals — `GET /api/drives/[driveId]/envs/[envId]/approvals`
 * (GA wave 3, leaf 6). The server's MIRROR of what the machine will run
 * without asking, as the owner's clicks recorded it; each row is revocable
 * through wave 2's `DELETE …/approvals/[approvalId]` beside this.
 *
 * **Owner only ([D-6]).** Every row names a command the owner approved on
 * the owner's own computer. A drive admin who did not enrol the machine may
 * REVOKE (the DELETE keeps its owner-or-admin rule — a reduction is not
 * driving) but may not SEE the list: 403 `not_owner`, audited, naming the
 * owner. Everything that shows a command is owner-only.
 *
 * The mirror is for visibility and revocation only. Nothing on this route,
 * or anywhere on the server, can send an approval TO a machine — the
 * account page's route suite pins that by reading the source.
 */
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, isPrincipalDriveMember } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getDriveEnvStore, listEnvApprovals, resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };

export async function GET(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
  try {
    const { driveId, envId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveMember(auth, driveId))) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'drive', resourceId: driveId, details: { route: 'drive-env-approvals', operation: 'list', envId } });
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }

    const env = await resolveEnvInDrive(envId, driveId);
    if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    if (env.substrate !== 'local') return NextResponse.json({ error: 'Only a local environment remembers approvals', reason: 'not_local' }, { status: 409 });

    const sibling = await (await getDriveEnvStore()).findLocalByEnvId(envId);
    if (!sibling) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });

    if (sibling.ownerId !== auth.userId) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'drive_env', resourceId: envId, details: { route: 'drive-env-approvals', operation: 'list', ownerId: sibling.ownerId }, riskScore: 0.3 });
      return NextResponse.json(
        { error: `Only this machine's owner (the user who enrolled it, ${sibling.ownerId}) can see what it will run without asking — drive admins can revoke an approval, but not read the list`, reason: 'not_owner', ownerId: sibling.ownerId },
        { status: 403 },
      );
    }

    const approvals = await listEnvApprovals(envId);
    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'drive_env', resourceId: envId, details: { route: 'drive-env-approvals', operation: 'list', driveId, rows: approvals.length } });
    return NextResponse.json({ approvals });
  } catch (error) {
    loggers.api.error('Failed to list environment approvals', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list approvals' }, { status: 500 });
  }
}
