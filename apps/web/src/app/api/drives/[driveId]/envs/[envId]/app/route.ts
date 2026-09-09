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
import { allocateUniqueSubdomainWithRetry, subdomainCollisionPrefix } from '@pagespace/lib/services/subdomain-allocation';
import { snapshotEnvFilesystem } from '@/lib/app-hosting/env-snapshot';
import { ensureBuildableSource, describeUnbuildableSourceReason } from '@/lib/app-hosting/publish-source-check';
import { enqueuePublishBuild } from '@/lib/app-hosting/publish-build-enqueue';
import { db } from '@pagespace/db/db';
import { and, eq, like, notInArray } from '@pagespace/db/operators';
import { publishedApps, type PublishedApp } from '@pagespace/db/schema/published-apps';
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

    // Refuse BEFORE any tar/snapshot/upload work if a build for this app is
    // already queued or actively running. `singletonKey` on the pg-boss job
    // only dedups a QUEUED job (see queue-manager.ts's own invariant) — once a
    // build is being actively worked, the row is `building`/`deploying`, so
    // this check catches exactly the case the queue layer cannot.
    if (existing && (existing.status === 'building' || existing.status === 'deploying')) {
      return NextResponse.json(
        { error: 'A build is already running for this app — wait for it to finish before publishing again.', reason: 'build_in_progress' },
        { status: 409 },
      );
    }

    // D1: "a Dockerfile at the root wins, else a default buildpack." Checked
    // BEFORE `createPublishedApp` and before any snapshot/tar/upload work — an
    // env whose source we cannot recognize must not leave a Fly app + hosting
    // row behind it, and a 400 here can never carry an `app` DTO because
    // nothing has been created yet. See `publish-source-check.ts`.
    const buildable = await ensureBuildableSource(env.sandboxId);
    if (!buildable.ok) {
      const status = buildable.reason === 'no_live_sandbox' ? 409 : buildable.reason === 'inspect_failed' || buildable.reason === 'sandbox_not_found' ? 502 : 400;
      return NextResponse.json(
        { error: describeUnbuildableSourceReason(buildable.reason), reason: buildable.reason },
        { status },
      );
    }

    // The snapshot is taken BEFORE `createPublishedApp`, not after — same
    // reasoning as `ensureBuildableSource` above, one step further: a
    // first-time publish must not leave a Fly app + hosting row behind a
    // snapshot failure. Taking it after used to leave a freshly created row
    // stuck at `building` forever (nothing ever moves it off that status on
    // this failure path), which is worse than merely "leaked" — the
    // status-transactional CAS below would then refuse every subsequent
    // publish attempt with 409 "already building", permanently, with no
    // retry path short of a manual unpublish. Neither the buildability check
    // nor the snapshot depends on `created.app`, only on `env.sandboxId`, so
    // both can run first. A merely HIBERNATING sprite wakes automatically
    // inside `snapshotEnvFilesystem` — the 409 below is only for an env that
    // never had a session at all.
    const snapshot = await snapshotEnvFilesystem(env.sandboxId);
    if (!snapshot.ok) {
      const status =
        snapshot.reason === 'onprem_unsupported'
          ? 404
          : snapshot.reason === 'no_live_sandbox'
            ? 409
            : snapshot.reason === 'too_large'
              ? 413
              : 502;
      return NextResponse.json(
        {
          error:
            snapshot.reason === 'onprem_unsupported'
              ? 'Not available'
              : snapshot.reason === 'no_live_sandbox'
                ? 'This environment has no live session to publish from — start a session in it first.'
                : snapshot.reason === 'too_large'
                  ? `This environment's filesystem is too large to publish (${snapshot.detail ?? 'over the interim cap'}) — exclude build artifacts and large binaries and try again.`
                  : `Could not snapshot the environment's filesystem: ${snapshot.reason}`,
          reason: snapshot.reason,
        },
        { status },
      );
    }

    const subdomain =
      existing?.subdomain ??
      (await allocateUniqueSubdomainWithRetry({
        base: env.name,
        fetchTaken: async () => {
          // Bounded to subdomains that could actually collide with THIS base —
          // see `subdomainCollisionPrefix`'s docblock for why the prefix
          // filter can never hide a real collision. Without it this was an
          // unbounded, unfiltered scan of the whole `published_apps` table on
          // every single publish, growing more expensive forever as the
          // platform grows.
          const prefix = subdomainCollisionPrefix(env.name);
          const rows = await db
            .select({ subdomain: publishedApps.subdomain })
            .from(publishedApps)
            .where(like(publishedApps.subdomain, `${prefix}%`));
          return rows.map((r) => r.subdomain);
        },
        attempt: async (candidate) => candidate,
      }));

    let enqueued: { jobId: string };
    let claimedApp: PublishedApp;
    try {
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

      // The status-transactional guard the early read-only check above cannot
      // provide: two publishes racing past that check both see a non-building
      // status and both reach here. This single UPDATE is the enqueue-time
      // record of the build AND its own concurrency check — Postgres commits
      // at most one of two racing UPDATEs with this WHERE clause, so exactly
      // one caller sees a returned row and proceeds; the loser gets an honest
      // 409, never a generic 500 from two callers enqueueing the same build
      // twice.
      const [claimed] = await db
        .update(publishedApps)
        .set({ status: 'building' })
        .where(and(eq(publishedApps.id, created.app.id), notInArray(publishedApps.status, ['building', 'deploying'])))
        .returning();

      if (!claimed) {
        return NextResponse.json(
          { error: 'A build is already running for this app — wait for it to finish before publishing again.', reason: 'build_in_progress' },
          { status: 409 },
        );
      }
      claimedApp = claimed;

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
      details: { route: 'drive-envs-app', operation: 'publish', envId, publishedAppId: claimedApp.id, jobId: enqueued.jobId },
    });

    return NextResponse.json({ app: toPublishedAppDTO(claimedApp), buildJobId: enqueued.jobId });
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
