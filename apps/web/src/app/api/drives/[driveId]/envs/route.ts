/**
 * Drive Environments API — `/api/drives/[driveId]/envs`.
 *
 * An environment is a PERSISTENT, drive-owned machine: named, shared by the
 * drive's members, and outliving every session that runs inside it. It is drive
 * INFRASTRUCTURE, which is why this route family nests under the drive (unlike
 * `/api/agent-workspaces/**`, which is flat because a session belongs to no
 * single container) and why its write verbs are owner/admin-only.
 *
 * GET    → { envs: DriveEnvDTO[] }   — any accepted member of the drive
 * POST   { name } → 201 { env }      — drive OWNER or ADMIN
 *
 * SHIPS DARK: nothing in the UI links here yet. The routes exist so the
 * sessions-inside-an-env work has something to build against.
 *
 * Two refusals are worth naming, because they are the ones a client will meet:
 * `409 name_taken` (an env is addressed by name, so `(driveId, name)` is
 * unique) and `402 env_limit_reached` / `403 tier_ineligible` from the per-plan
 * environment allowance — an env row is the billed persistence unit, metered
 * against the DRIVE OWNER, so a free-tier drive gets none at all.
 */

import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveMember,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createDriveEnvRequestSchema } from '@pagespace/lib/drive-envs/env-contract';
import { createEnvInDrive, listEnvsInDrive, toDriveEnvDTO } from '@/lib/drive-envs/drive-envs-runtime';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function GET(request: Request, context: { params: Promise<{ driveId: string }> }) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    // Reading the drive's machines is a MEMBER capability: an env is shared
    // infrastructure, and a member who may spawn a session inside one has to be
    // able to see it exists. Administering it is a different question, below.
    if (!(await isPrincipalDriveMember(auth, driveId))) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: auth.userId,
        resourceType: 'drive',
        resourceId: driveId,
        details: { route: 'drive-envs', operation: 'list' },
      });
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }

    return NextResponse.json({ envs: await listEnvsInDrive(driveId) });
  } catch (error) {
    loggers.api.error('Failed to list drive environments', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list environments' }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ driveId: string }> }) {
  try {
    const { driveId } = await context.params;
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
        details: { route: 'drive-envs', operation: 'create' },
      });
      return NextResponse.json({ error: 'Only drive owners and admins can create environments' }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const parsed = createDriveEnvRequestSchema.safeParse(body);
    if (!parsed.success) {
      // Name the field that failed: an unknown substrate is not a name problem,
      // and a blank label is invalid rather than merely missing.
      const failed = new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')));
      const error = failed.has('substrate')
        ? "substrate must be 'sprite' or 'local'"
        : failed.has('label')
          ? 'A machine label (1–64 characters) is required for a local environment'
          : failed.has('name')
            ? 'A non-empty environment name is required'
            : 'Invalid environment request';
      return NextResponse.json({ error }, { status: 400 });
    }

    // Local environments (the user's own machine via the zero-trust bridge)
    // are a cloud OPT-IN: never minted — and never a Sprite env in their
    // place — unless the deployment turned them on.
    if (parsed.data.substrate === 'local' && !isLocalEnvsEnabled()) {
      return NextResponse.json({ error: 'Local environments are not enabled on this deployment' }, { status: 501 });
    }

    const local = parsed.data.substrate === 'local' ? { label: parsed.data.label, ownerId: auth.userId } : undefined;
    const result = await createEnvInDrive({ driveId, name: parsed.data.name, createdBy: auth.userId, local });
    if (!result.ok) {
      if (result.reason === 'drive_not_found') {
        return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
      }
      if (result.reason === 'name_taken') {
        return NextResponse.json({ error: 'An environment with this name already exists' }, { status: 409 });
      }
      // Quota. The two denials get DIFFERENT statuses because they have
      // different remedies: an ineligible tier is a forbidden feature (403),
      // a reached ceiling is a payment-required upgrade or a deletion (402) —
      // the same split the sandbox quota surfaces elsewhere.
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: auth.userId,
        resourceType: 'drive',
        resourceId: driveId,
        details: { route: 'drive-envs', operation: 'create', denial: result.denial, limit: result.limit },
      });
      return NextResponse.json(
        {
          error:
            result.denial === 'tier_ineligible'
              ? 'Environments are not available on this plan'
              : 'Environment limit reached for this plan',
          reason: result.denial,
          limit: result.limit,
        },
        { status: result.denial === 'tier_ineligible' ? 403 : 402 },
      );
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { route: 'drive-envs', operation: 'create', envId: result.env.id, name: result.env.name, substrate: result.env.substrate },
    });

    // A local env is born disconnected (no machine has enrolled yet) and the
    // one-time code rides the response ONCE — the server keeps only its hash.
    if (local && result.enrollment) {
      return NextResponse.json(
        {
          env: toDriveEnvDTO(result.env, { label: local.label, status: 'disconnected' }),
          enrollment: { enrollmentId: result.enrollment.enrollmentId, code: result.enrollment.code, expiresAt: result.enrollment.expiresAt.toISOString() },
        },
        { status: 201 },
      );
    }
    return NextResponse.json({ env: toDriveEnvDTO(result.env) }, { status: 201 });
  } catch (error) {
    loggers.api.error('Failed to create drive environment', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to create environment' }, { status: 500 });
  }
}
