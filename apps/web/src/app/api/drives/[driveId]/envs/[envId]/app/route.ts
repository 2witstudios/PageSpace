/**
 * The published-app hosting row for one environment —
 * `/api/drives/[driveId]/envs/[envId]/app`.
 *
 * GET    → { app: AppDTO | null }   — any accepted member of the drive
 * POST   → { app: AppDTO }          — drive OWNER or ADMIN. Publish, or
 *          re-publish (a fresh build of the same app — idempotent by design).
 * DELETE → { unpublished: true }    — drive OWNER or ADMIN. Unpublish: destroys
 *          the hosting row and its Fly app. NEVER touches `drive_envs` — the
 *          environment outlives its hosting row and can be published again.
 *
 * `driveId` is checked against the env row, not trusted from the path — same
 * shape as `../route.ts`, for the same reason (id-guessing across drives must
 * 404, not leak existence via 403).
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
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { createPublishedApp, destroyPublishedApp } from '@pagespace/lib/services/app-hosting/provisioner';
import { resolvePublishedAppsOrgSlug } from '@pagespace/lib/services/app-hosting/app-hosting-env';
import { allocateUniqueSubdomainWithRetry } from '@pagespace/lib/services/subdomain-allocation';
import { snapshotEnvFilesystem } from '@/lib/app-hosting/env-snapshot';
import { enqueuePublishBuild } from '@/lib/app-hosting/publish-build-enqueue';
import { db } from '@pagespace/db/db';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { findPublishedAppByEnvId, toPublishedAppDTO } from '@/lib/app-hosting/published-app-dto';

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
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }

    if (!(await resolveEnvInDrive(envId, driveId))) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }

    const app = await findPublishedAppByEnvId(envId);
    return NextResponse.json({ app: app ? toPublishedAppDTO(app) : null });
  } catch (error) {
    loggers.api.error('Failed to read published app', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to read published app' }, { status: 500 });
  }
}

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
        details: { route: 'drive-envs-app', operation: 'publish', envId },
      });
      return NextResponse.json({ error: 'Only drive owners and admins can publish an environment' }, { status: 403 });
    }

    const env = await resolveEnvInDrive(envId, driveId);
    if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });

    // The subdomain is allocated once, on FIRST publish only — createPublishedApp
    // ignores it on a retry/re-publish of an existing row (see its docblock: a
    // republish must not silently rename the app's live address).
    const existing = await findPublishedAppByEnvId(envId);
    const subdomain =
      existing?.subdomain ??
      (await allocateUniqueSubdomainWithRetry({
        base: env.name,
        fetchTaken: async () => {
          const rows = await db.select({ subdomain: publishedApps.subdomain }).from(publishedApps);
          return rows.map((r) => r.subdomain);
        },
        attempt: async (candidate) => candidate,
      }));

    const created = await createPublishedApp({
      envId,
      driveId,
      ownerId: auth.userId,
      subdomain,
      orgSlug: resolvePublishedAppsOrgSlug(),
    });

    if (!created.ok) {
      const status =
        created.reason === 'fly_error'
          ? 502
          : created.reason === 'raced'
            ? 409
            : 404;
      return NextResponse.json({ error: `Publish failed: ${created.reason}`, reason: created.reason }, { status });
    }

    // Re-publish means "build again", even when createPublishedApp's own answer
    // was a no-op on the ROW — the row being unchanged says nothing about whether
    // the environment's filesystem has changed since the last build. A merely
    // HIBERNATING sprite wakes automatically inside snapshotEnvFilesystem — the
    // 409 below is only for an env that never had a session at all.
    const snapshot = await snapshotEnvFilesystem(env.sandboxId);
    if (!snapshot.ok) {
      const status = snapshot.reason === 'no_live_sandbox' ? 409 : 502;
      return NextResponse.json(
        {
          error:
            snapshot.reason === 'no_live_sandbox'
              ? 'This environment has no live session to publish from — start a session in it first.'
              : `Could not snapshot the environment's filesystem: ${snapshot.reason}`,
          reason: snapshot.reason,
          app: toPublishedAppDTO(created.app),
        },
        { status },
      );
    }

    let enqueued;
    try {
      enqueued = await enqueuePublishBuild({
        publishedAppId: created.app.id,
        tarPath: snapshot.tarPath,
        callerUserId: auth.userId,
      });
    } finally {
      await snapshot.cleanup();
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { route: 'drive-envs-app', operation: 'publish', envId, publishedAppId: created.app.id, jobId: enqueued.jobId },
    });

    return NextResponse.json({ app: toPublishedAppDTO(created.app), buildJobId: enqueued.jobId });
  } catch (error) {
    loggers.api.error('Failed to publish environment', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to publish environment' }, { status: 500 });
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
        details: { route: 'drive-envs-app', operation: 'unpublish', envId },
      });
      return NextResponse.json({ error: 'Only drive owners and admins can unpublish an environment' }, { status: 403 });
    }

    if (!(await resolveEnvInDrive(envId, driveId))) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }

    const app = await findPublishedAppByEnvId(envId);
    if (!app) return NextResponse.json({ error: 'This environment is not published' }, { status: 404 });

    const result = await destroyPublishedApp(app.id);
    if (!result.ok) {
      const status = result.reason === 'fly_error' ? 502 : 404;
      return NextResponse.json(
        {
          error:
            result.reason === 'fly_error'
              ? `Unpublish is retrying — the hosting row is marked for teardown: ${result.error}`
              : `Unpublish failed: ${result.reason}`,
          reason: result.reason,
        },
        { status },
      );
    }

    auditRequest(request, {
      eventType: 'data.delete',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { route: 'drive-envs-app', operation: 'unpublish', envId, publishedAppId: app.id },
    });

    return NextResponse.json({ unpublished: true });
  } catch (error) {
    loggers.api.error('Failed to unpublish environment', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to unpublish environment' }, { status: 500 });
  }
}
