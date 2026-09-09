/**
 * Revoke ONE remembered approval on a local environment's machine —
 * `DELETE /api/drives/[driveId]/envs/[envId]/approvals/[approvalId]`
 * (GA wave 2, leaf 8).
 *
 * The machine remembers an owner's approval under the challenge id it was
 * answered with (`~/.pagespace/env-approvals.json`). This route asks the
 * machine to delete exactly that entry, over the existing signed `revoke`
 * frame with `approvalId` set — signed under its own domain by the key the
 * enrollment pinned, so it can never be turned into an enrollment revoke.
 *
 * **Who may:** the environment OWNER (the human who enrolled it), or a drive
 * owner/admin — revoking narrows and only narrows, and [D-6] keeps Revoke with
 * drive admins. Nobody can ADD an approval through PageSpace: the machine file
 * is authoritative for allow; the server may only revoke.
 *
 * **Honest about reach.** The frame goes over the env's live socket on this
 * replica. Without one the machine still holds the approval; the answer says
 * so (`machine: 'no_live_socket'`, 409) rather than claiming a revoke that
 * was never delivered. Every attempt is audited on the env with the id.
 */
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, isPrincipalDriveMember, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { getDriveEnvStore } from '@/lib/drive-envs/drive-envs-runtime';
import { revokeLocalEnvApproval } from '@/lib/env-bridge/revoke';

const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function DELETE(request: Request, context: { params: Promise<{ driveId: string; envId: string; approvalId: string }> }) {
  try {
    const { driveId, envId, approvalId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveMember(auth, driveId))) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'drive', resourceId: driveId, details: { route: 'drive-env-approvals', operation: 'revoke', envId, approvalId } });
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }

    const env = await resolveEnvInDrive(envId, driveId);
    if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    if (env.substrate !== 'local') return NextResponse.json({ error: 'Only a local environment remembers approvals', reason: 'not_local' }, { status: 409 });

    const sibling = await (await getDriveEnvStore()).findLocalByEnvId(envId);
    if (!sibling) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });

    // The env OWNER, or drive administration (Revoke stays with admins under D-6).
    const allowed = sibling.ownerId === auth.userId || (await isPrincipalDriveOwnerOrAdmin(auth, driveId));
    if (!allowed) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'drive_env', resourceId: envId, details: { route: 'drive-env-approvals', operation: 'revoke', approvalId, ownerId: sibling.ownerId }, riskScore: 0.3 });
      return NextResponse.json({ error: "Only this machine's owner or a drive admin can revoke an approval on it", reason: 'not_owner' }, { status: 403 });
    }

    const result = await revokeLocalEnvApproval({ envId, approvalId, reason: `revoked_by_${auth.userId}` });
    if (!result.ok) {
      if (result.reason === 'not_found') return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
      return NextResponse.json({ error: 'This environment has been revoked', reason: 'revoked' }, { status: 409 });
    }
    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'drive_env', resourceId: envId, details: { route: 'drive-env-approvals', operation: 'revoke', approvalId, machine: result.machine } });
    if (result.machine !== 'sent') {
      return NextResponse.json({ revoked: false, machine: result.machine, error: 'The machine is not connected right now, so it still holds this approval. Connect it and try again.' }, { status: 409 });
    }
    return NextResponse.json({ revoked: true, machine: result.machine, approvalId });
  } catch (error) {
    loggers.api.error('Failed to revoke an environment approval', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to revoke the approval' }, { status: 500 });
  }
}
