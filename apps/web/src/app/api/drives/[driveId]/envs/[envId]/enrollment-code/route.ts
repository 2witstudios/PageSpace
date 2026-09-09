/**
 * A fresh one-time enrollment code — `POST /api/drives/[driveId]/envs/[envId]/enrollment-code`.
 *
 * The create response carries a local env's code exactly once. Before this
 * route existed, closing that dialog, losing the clipboard, or letting the ten
 * minutes run out left the env PERMANENTLY unenrollable — a row that could only
 * be deleted and made again (Local Environments epic, M3). Re-issue is the
 * load-bearing fix: it replaces the code for an env whose machine has NOT yet
 * enrolled, and refuses, typed, for one that has.
 *
 * Its own sub-route and a POST, like `rebuild`: this is an ACT on the env, not
 * an edit to its attributes. Owner/admin, exactly the bar every other env write
 * meets, and only on a deployment that opted into local envs.
 *
 * POST → 201 { enrollment: { enrollmentId, code, expiresAt } }
 *
 * Refusals a client will meet: `409 not_local` (a Sprite env has no code),
 * `409 already_enrolled` (a machine already pinned its key — this is FINAL,
 * because re-opening an enrolled env to a second key would be a takeover),
 * `410 revoked`. The `already_enrolled` answer is decided by the store's
 * compare-and-set, not by a read here.
 */

import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { reissueEnvEnrollmentCode, resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';

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
        details: { route: 'drive-envs', operation: 'reissue-enrollment-code', envId },
      });
      return NextResponse.json({ error: 'Only drive owners and admins can issue enrollment codes' }, { status: 403 });
    }

    // The same opt-in the create path enforces: with local envs off there is
    // nothing to enrol and no code to mint.
    if (!isLocalEnvsEnabled()) {
      return NextResponse.json({ error: 'Local environments are not enabled on this deployment' }, { status: 501 });
    }

    const env = await resolveEnvInDrive(envId, driveId);
    if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    if (env.substrate !== 'local') {
      return NextResponse.json({ error: 'Only a local environment has an enrollment code', reason: 'not_local' }, { status: 409 });
    }

    const result = await reissueEnvEnrollmentCode({ envId });
    if (!result.ok) {
      if (result.reason === 'not_found') return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
      if (result.reason === 'revoked') {
        return NextResponse.json({ error: 'This environment’s machine was revoked; delete the environment and create a new one', reason: result.reason }, { status: 410 });
      }
      return NextResponse.json({ error: 'A machine has already enrolled in this environment', reason: result.reason }, { status: 409 });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { route: 'drive-envs', operation: 'reissue-enrollment-code', envId, enrollmentId: result.enrollment.enrollmentId },
    });

    // The code rides the response ONCE — the server keeps only its hash.
    return NextResponse.json(
      {
        enrollment: {
          enrollmentId: result.enrollment.enrollmentId,
          code: result.enrollment.code,
          expiresAt: result.enrollment.expiresAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    loggers.api.error('Failed to re-issue drive environment enrollment code', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to issue an enrollment code' }, { status: 500 });
  }
}
