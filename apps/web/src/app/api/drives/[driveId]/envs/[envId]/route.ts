/**
 * One drive environment — `/api/drives/[driveId]/envs/[envId]`.
 *
 * GET    → { env }                          — any accepted member of the drive
 * PATCH  { name } → { env }                 — drive OWNER or ADMIN
 * PATCH  { serverPolicy } → { env, serverPolicy } — the ENV OWNER only (D-6)
 * PATCH  { paused } → { env, paused }       — the ENV OWNER only (D-6; Stop / Resume, GA wave 3)
 * DELETE ?force=true → { deleted }          — drive OWNER or ADMIN
 *
 * **Three PATCH fields, three rules, one per request.** A rename is drive
 * administration, so it keeps the owner-or-admin gate. `serverPolicy` — what
 * PageSpace may ask a LOCAL machine to do, enforced at signing (GA wave 1) —
 * belongs to the human who enrolled the machine and to nobody else: the check
 * is against `drive_env_local.ownerId`, never a drive role, and a drive admin
 * who did not enrol it is refused 403 naming the owner ([D-6]). The store
 * write is a compare-and-set on `(envId, ownerId, revokedAt IS NULL)`.
 *
 * **`driveId` is checked against the row, not trusted from the path.** An env's
 * id is globally unique, so a member of drive A could otherwise reach drive B's
 * env by nesting its id under a drive they do belong to. The mismatch answers
 * 404 rather than 403: telling a stranger that an id exists elsewhere is itself
 * the leak.
 *
 * **DELETE on a LOCAL env revokes the machine first** (Local Environments epic,
 * Codex C4): `revokedAt` stamped, every `env:bridge` session for the env
 * revoked, the daemon sent a signed `revoke` frame and closed 1008 — then the
 * row is deleted as for any env. Owner/admin only, through the same
 * centralized check as every other DELETE here; the revoke's three legs are
 * audited on the drive with `operation: 'revoke'`.
 *
 * **DELETE is the destructive verb.** It refuses while sessions are live inside
 * the env (409) unless `?force=true`, because deleting the row CASCADES those
 * sessions away — see `deleteDriveEnv`, which owns the ordering: guard → delete
 * the row → kill the machine, in that order and for that reason. The kill comes
 * LAST so that a refusal cannot leave a destroyed filesystem behind, and it is
 * therefore best-effort: a kill that fails or stalls does NOT abort the delete
 * and does not fail this request. The environment is gone; the reclaim outbox
 * finishes stopping the machine. `spriteTornDown` in the response says whether
 * this request also managed that, which is why it is reported rather than
 * assumed — there is deliberately no 503 arm.
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
import { patchDriveEnvRequestSchema } from '@pagespace/lib/drive-envs/env-contract';
import {
  deleteEnv,
  renameEnv,
  readEnvDTO,
  resolveEnvInDrive,
  revokeEnv,
  setEnvServerPolicy,
  setEnvPaused,
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

    // Through the facts join: a LOCAL row handed bare to `toDriveEnvDTO` throws
    // (by design), which used to make this GET a 500 for every local env.
    return NextResponse.json({ env: await readEnvDTO(env) });
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

    const body = await request.json().catch(() => null);
    const parsed = patchDriveEnvRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Exactly one of a non-empty environment name, a server policy ({ ops: [exec | fs_read | fs_write], checkpoint: false }), or paused (true | false) is required' }, { status: 400 });
    }

    // ---- paused: STOP / RESUME, the env OWNER only (D-6; GA wave 3). Pauses
    // the env's grants without deleting it or revoking its key; a drive admin
    // who did not enrol the machine keeps Delete and is refused here.
    if (parsed.data.paused !== undefined) {
      const env = await resolveEnvInDrive(envId, driveId);
      if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
      if (env.substrate !== 'local') {
        return NextResponse.json({ error: 'Only a local environment can be stopped', reason: 'not_local' }, { status: 409 });
      }
      const operation = parsed.data.paused ? 'pause' : 'resume';
      const result = await setEnvPaused({ envId, requesterId: auth.userId, paused: parsed.data.paused });
      if (!result.ok) {
        if (result.reason === 'not_owner') {
          auditRequest(request, {
            eventType: 'authz.access.denied',
            userId: auth.userId,
            resourceType: 'drive_env',
            resourceId: envId,
            details: { route: 'drive-envs', operation, driveId, ownerId: result.ownerId },
            riskScore: 0.4,
          });
          return NextResponse.json(
            { error: `Only this machine's owner (the user who enrolled it, ${result.ownerId}) can stop or resume it — drive admins can delete or revoke it, but not drive it`, reason: 'not_owner', ownerId: result.ownerId },
            { status: 403 },
          );
        }
        if (result.reason === 'not_found') return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
        return NextResponse.json({ error: 'This environment has been revoked', reason: 'revoked' }, { status: 409 });
      }
      auditRequest(request, {
        eventType: 'data.write',
        userId: auth.userId,
        resourceType: 'drive_env',
        resourceId: envId,
        details: { route: 'drive-envs', operation, driveId, envId },
      });
      return NextResponse.json({ env: await readEnvDTO(env), paused: result.paused });
    }

    // ---- serverPolicy: the env OWNER only (D-6). No drive role is consulted:
    // a plain member who enrolled the machine may; an admin who did not may not.
    if (parsed.data.serverPolicy !== undefined) {
      const env = await resolveEnvInDrive(envId, driveId);
      if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
      if (env.substrate !== 'local') {
        return NextResponse.json({ error: 'Only a local environment has a server policy', reason: 'not_local' }, { status: 409 });
      }
      const result = await setEnvServerPolicy({ envId, requesterId: auth.userId, serverPolicy: parsed.data.serverPolicy });
      if (!result.ok) {
        if (result.reason === 'not_owner') {
          auditRequest(request, {
            eventType: 'authz.access.denied',
            userId: auth.userId,
            resourceType: 'drive_env',
            resourceId: envId,
            details: { route: 'drive-envs', operation: 'set_server_policy', driveId, ownerId: result.ownerId },
            riskScore: 0.4,
          });
          return NextResponse.json(
            { error: `Only this machine's owner (the user who enrolled it, ${result.ownerId}) can change what it may run — drive admins can delete or revoke it, but not drive it`, reason: 'not_owner', ownerId: result.ownerId },
            { status: 403 },
          );
        }
        if (result.reason === 'not_found') return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
        return NextResponse.json({ error: 'This environment has been revoked', reason: 'revoked' }, { status: 409 });
      }
      auditRequest(request, {
        eventType: 'data.write',
        userId: auth.userId,
        resourceType: 'drive_env',
        resourceId: envId,
        details: { route: 'drive-envs', operation: 'set_server_policy', driveId, envId, ops: result.serverPolicy.ops },
      });
      return NextResponse.json({ env: await readEnvDTO(env), serverPolicy: result.serverPolicy });
    }

    // ---- name: drive administration (owner or admin), unchanged.
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

    const result = await renameEnv({ envId, name: parsed.data.name ?? '' });
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
    loggers.api.error('Failed to update drive environment', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to update environment' }, { status: 500 });
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

    const env = await resolveEnvInDrive(envId, driveId);
    if (!env) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }

    // A local env's machine is revoked BEFORE the row goes: the stamp, the
    // sessions and the socket (C4). The row deletion below then cascades the
    // sibling away; a later token mint finds nothing and fails either way.
    let revoked: { sessionsRevoked: number; machine: string; alreadyRevoked: boolean } | null = null;
    if (env.substrate === 'local') {
      const revocation = await revokeEnv({ envId, reason: 'owner_revoked' });
      if (revocation.ok) {
        revoked = { sessionsRevoked: revocation.sessionsRevoked, machine: revocation.machine, alreadyRevoked: revocation.alreadyRevoked };
        auditRequest(request, {
          eventType: 'auth.token.revoked',
          userId: auth.userId,
          resourceType: 'drive_env',
          resourceId: envId,
          details: { route: 'drive-envs', operation: 'revoke', driveId, ...revoked },
        });
      }
    }

    // Opt-in by exact value: any other spelling reads as "not forced", so a
    // stray `?force` or `?force=0` can never destroy a drive's shared work.
    const force = new URL(request.url).searchParams.get('force') === 'true';
    const result = await deleteEnv({ envId, force });

    // Two refusals, both terminal. There is deliberately no `teardown_failed`
    // arm any more: the delete now kills the Sprite only AFTER the row is gone,
    // so a kill this request could not confirm is the reclaim outbox's problem
    // rather than a failure to report — the environment IS deleted either way.
    if (!result.ok) {
      if (result.reason === 'not_found') return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
      return NextResponse.json(
        {
          error: 'Sessions are still running in this environment',
          reason: 'live_sessions',
          liveSessionCount: result.liveSessionCount,
        },
        { status: 409 },
      );
    }

    auditRequest(request, {
      eventType: 'data.delete',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { route: 'drive-envs', operation: 'delete', envId, force, spriteTornDown: result.spriteTornDown, revoked },
    });

    return NextResponse.json({ deleted: true, spriteTornDown: result.spriteTornDown, ...(revoked && { revoked }) });
  } catch (error) {
    loggers.api.error('Failed to delete drive environment', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to delete environment' }, { status: 500 });
  }
}
