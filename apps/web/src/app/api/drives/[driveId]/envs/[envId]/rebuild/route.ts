/**
 * Rebuild an environment's machine — `POST /api/drives/[driveId]/envs/[envId]/rebuild`.
 *
 * Its own sub-route, and a POST, because it is an ACT rather than an edit to the
 * env's fields: PATCH on the parent means "these are the env's new attributes",
 * and nothing about a rebuild changes an attribute — same id, same name, same
 * address, new machine. The drive's other imperative verbs (`restore`,
 * `publish-home`, `verify`) are shaped the same way.
 *
 * **This is the ONLY sprite-replacing verb**, and it is destructive by design:
 * the environment's filesystem does not survive. That is what the caller is
 * asking for — a wedged daemon, a full disk, a dependency tree past saving — and
 * it is why the gate is drive OWNER or ADMIN rather than anyone who may run code
 * in the env. `rebuildDriveEnv` owns the ordering: the old Sprite must be
 * CONFIRMED dead before the new one is minted, because the Sprite name is
 * deterministic in the env id and provisioning first would hand back the same
 * disk while reporting a rebuild.
 */

import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { rebuildEnv, resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';

const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function POST(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
  try {
    const { driveId, envId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: auth.userId,
        resourceType: 'drive',
        resourceId: driveId,
        details: { route: 'drive-envs', operation: 'rebuild', envId },
      });
      return NextResponse.json({ error: 'Only drive owners and admins can rebuild environments' }, { status: 403 });
    }

    if (!(await resolveEnvInDrive(envId, driveId))) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }

    const result = await rebuildEnv({ envId, requesterId: auth.userId });
    if (!result.ok) {
      if (result.reason === 'not_found') return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
      // Both remaining failures leave the env intact and retryable — the
      // teardown one still on its old machine, the provision one machineless
      // until the next ensure — so both are 503 rather than a 4xx the client
      // could read as "stop asking".
      loggers.api.error(
        `Drive environment rebuild failed (${result.reason})`,
        new Error(result.detail),
        { envId },
      );
      return NextResponse.json({ error: 'Could not rebuild the environment', reason: result.reason }, { status: 503 });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { route: 'drive-envs', operation: 'rebuild', envId },
    });

    return NextResponse.json({ rebuilt: true });
  } catch (error) {
    loggers.api.error('Failed to rebuild drive environment', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to rebuild environment' }, { status: 500 });
  }
}
