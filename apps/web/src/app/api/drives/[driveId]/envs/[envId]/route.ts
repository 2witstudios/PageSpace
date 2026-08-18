/**
 * One drive environment — `/api/drives/[driveId]/envs/[envId]`.
 *
 * GET    → { env }                 — any accepted member of the drive
 * PATCH  { name } → { env }        — drive OWNER or ADMIN
 * DELETE ?force=true → { deleted }  — drive OWNER or ADMIN
 *
 * **`driveId` is checked against the row, not trusted from the path.** An env's
 * id is globally unique, so a member of drive A could otherwise reach drive B's
 * env by nesting its id under a drive they do belong to. The mismatch answers
 * 404 rather than 403: telling a stranger that an id exists elsewhere is itself
 * the leak.
 *
 * **DELETE is the destructive verb.** It refuses while sessions are live inside
 * the env (409) unless `?force=true`, because deleting the row CASCADES those
 * sessions away — see `deleteDriveEnv`, which owns the ordering (guard → kill →
 * confirm → row) and aborts the delete if the kill could not be confirmed.
 */

import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveMember,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { renameDriveEnvRequestSchema } from '@pagespace/lib/drive-envs/env-contract';
import {
  deleteEnv,
  renameEnv,
  resolveEnvInDrive,
  toDriveEnvDTO,
} from '@/lib/drive-envs/drive-envs-runtime';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function GET(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
  try {
    const { driveId, envId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveMember(auth, driveId))) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: auth.userId,
        resourceType: 'drive',
        resourceId: driveId,
        details: { route: 'drive-envs', operation: 'read', envId },
      });
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }

    const env = await resolveEnvInDrive(envId, driveId);
    if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });

    return NextResponse.json({ env: toDriveEnvDTO(env) });
  } catch (error) {
    loggers.api.error('Failed to read drive environment', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to read environment' }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
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
        details: { route: 'drive-envs', operation: 'rename', envId },
      });
      return NextResponse.json({ error: 'Only drive owners and admins can rename environments' }, { status: 403 });
    }

    if (!(await resolveEnvInDrive(envId, driveId))) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const parsed = renameDriveEnvRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'A non-empty environment name is required' }, { status: 400 });
    }

    const result = await renameEnv({ envId, name: parsed.data.name });
    if (!result.ok) {
      if (result.reason === 'not_found') return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
      return NextResponse.json({ error: 'An environment with this name already exists' }, { status: 409 });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { route: 'drive-envs', operation: 'rename', envId, name: result.env.name },
    });

    return NextResponse.json({ env: toDriveEnvDTO(result.env) });
  } catch (error) {
    loggers.api.error('Failed to rename drive environment', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to rename environment' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
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
        details: { route: 'drive-envs', operation: 'delete', envId },
      });
      return NextResponse.json({ error: 'Only drive owners and admins can delete environments' }, { status: 403 });
    }

    if (!(await resolveEnvInDrive(envId, driveId))) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }

    // Opt-in by exact value: any other spelling reads as "not forced", so a
    // stray `?force` or `?force=0` can never destroy a drive's shared work.
    const force = new URL(request.url).searchParams.get('force') === 'true';
    const result = await deleteEnv({ envId, force });

    if (!result.ok) {
      if (result.reason === 'not_found') return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
      if (result.reason === 'live_sessions') {
        return NextResponse.json(
          {
            error: 'Sessions are still running in this environment',
            reason: 'live_sessions',
            liveSessionCount: result.liveSessionCount,
          },
          { status: 409 },
        );
      }
      // The kill could not be confirmed, so the row was deliberately NOT
      // deleted: it is the reconciler's only handle on a VM that may still be
      // running. A retry is the right client behavior, hence 503.
      loggers.api.error('Drive environment teardown failed', new Error(result.detail), { envId });
      return NextResponse.json({ error: 'Could not tear down the environment machine', reason: 'teardown_failed' }, { status: 503 });
    }

    auditRequest(request, {
      eventType: 'data.delete',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { route: 'drive-envs', operation: 'delete', envId, force, spriteTornDown: result.spriteTornDown },
    });

    return NextResponse.json({ deleted: true, spriteTornDown: result.spriteTornDown });
  } catch (error) {
    loggers.api.error('Failed to delete drive environment', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to delete environment' }, { status: 500 });
  }
}
