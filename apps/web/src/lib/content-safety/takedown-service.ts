import 'server-only';

import { db } from '@pagespace/db/db';
import { and, eq, isNotNull } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import type { ContentCase } from '@pagespace/db/schema/content-safety';
import { audit } from '@pagespace/lib/audit/audit-log';
import { suspendUser } from '@pagespace/lib/auth/suspend-user';
import { sendContentSafetyAlert } from '@pagespace/lib/content-safety/alerts';
import { createTakedownCaseStore, getContentCase, openTakedownCase } from '@pagespace/lib/content-safety/case-store';
import { normalizeContentHash } from '@pagespace/lib/content-safety/policy';
import {
  resweepGlobalTakedown,
  runGlobalTakedown,
  runLinearCase,
  type LinearStep,
  type TakedownDeps,
  type TakedownRunResult,
} from '@pagespace/lib/content-safety/takedown';
import type { TakedownRequest, TakedownResponse } from '@pagespace/lib/content-safety/takedown-request';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  parkDriveSites,
  parkUserSites,
  restoreDriveSites,
  restoreUserSites,
  type UserSitesOutcome,
} from '@pagespace/lib/organizations/published-visibility';
import type { PublishedObjectStore } from '@pagespace/lib/organizations/published-visibility-core';
import { createSystemAvatarDeleteToken } from '@pagespace/lib/services/validated-service-token';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createPublishedObjectStore, isPublishConfigured } from '@/lib/canvas/published-storage';
import { getS3Bucket, getS3Client } from '@/lib/presigned-url';
import { unpublishPage } from '@/lib/canvas/unpublish-page';
import { createTakedownStorage } from './takedown-storage';

/**
 * Content takedown — every action an admin can take, executed here in the web
 * app because it is the only service with credentials for both buckets.
 *
 * Each action opens (or reuses) a case and runs its steps through the lib
 * executor, which records every step on the case. `resume` reruns whatever the
 * case is, from the first step that has not succeeded.
 *
 * Callers are the service-authenticated internal route and the re-sweep cron.
 * Nothing here checks who is asking.
 */

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

export class TakedownRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'TakedownRequestError';
  }
}

/** With no publish bucket there is nothing published to move; a store that lists nothing keeps the hold logic intact. */
function publishedStore(): PublishedObjectStore {
  if (isPublishConfigured()) return createPublishedObjectStore();
  return {
    listKeys: async () => [],
    listPrefixes: async () => [],
    exists: async () => false,
    copy: async () => undefined,
    remove: async () => undefined,
  };
}

function createTakedownDeps(actorUserId: string | null): TakedownDeps {
  return {
    cases: createTakedownCaseStore(),
    storage: createTakedownStorage(),
    async suspendUser({ userId, reason }) {
      // A takedown never suspends an admin on its own: that is a decision for a person.
      const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
      if (target?.role === 'admin') return { status: 'skipped_admin' };

      const outcome = await suspendUser({ userId, reason });
      if (outcome.status === 'suspended') {
        // The same event the admin suspend route writes, so a user's audit
        // trail shows the suspension whichever path caused it.
        audit({
          eventType: 'admin.user.suspended',
          userId: actorUserId ?? undefined,
          resourceType: 'user',
          resourceId: userId,
          details: { source: 'content_takedown', action: 'suspend', reason, revokedSessions: outcome.revokedSessions },
        });
      }
      return outcome;
    },
    alert: sendContentSafetyAlert,
  };
}

async function alertOpened(row: ContentCase, deps: TakedownDeps): Promise<void> {
  try {
    await deps.alert({ event: 'opened', caseId: row.id, category: row.category });
  } catch {
    // Best-effort, like every other alert: the case row is the record.
  }
}

/**
 * Ask the processor to delete a user's avatar objects, through its existing
 * service-auth route, then check for ourselves that none are left: the
 * processor's delete does not report per-object failures, and "done" on a case
 * has to mean the objects are gone.
 */
async function deleteAvatarObjects(userId: string): Promise<string> {
  const { token } = await createSystemAvatarDeleteToken({ userId });
  const response = await fetch(`${PROCESSOR_URL}/api/avatar/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Processor refused the avatar delete (${response.status})`);

  const remaining = await getS3Client().send(
    new ListObjectsV2Command({ Bucket: getS3Bucket(), Prefix: `avatars/${userId}/`, MaxKeys: 1 }),
  );
  if ((remaining.Contents ?? []).length > 0) {
    throw new Error('Avatar objects are still present after the processor delete');
  }
  return 'processor_deleted';
}

/**
 * Clear the profile image so nothing renders the removed avatar. An image we
 * host is now a dead link; an external one (an OAuth provider's URL) is not ours
 * to delete, but we stop displaying it.
 */
async function clearProfileImage(userId: string): Promise<string> {
  const cleared = await db
    .update(users)
    .set({ image: null })
    .where(and(eq(users.id, userId), isNotNull(users.image)))
    .returning({ id: users.id });
  return cleared.length > 0 ? 'cleared' : 'no_image';
}

interface CaseRun {
  result: TakedownRunResult;
  userSites?: UserSitesOutcome;
}

/** Run whatever takedown the case is. The single place a case's kind is turned into steps. */
async function runCase(row: ContentCase, deps: TakedownDeps): Promise<CaseRun> {
  const takedown = row.snapshot?.takedown;
  const actor = takedown?.actorUserId ?? null;
  const linear = async (plan: LinearStep[]): Promise<CaseRun> => ({ result: await runLinearCase(row.id, plan, deps) });

  switch (takedown?.kind) {
    case 'global':
      return { result: await runGlobalTakedown(row.id, deps) };

    case 'unpublish_page':
      return linear([
        {
          step: 'unpublish',
          run: async () => {
            const outcome = await unpublishPage(row.targetId);
            if (!outcome.unpublished) return 'not_published';
            await deps.cases.mergeSnapshot(row.id, { pageIds: [row.targetId], driveIds: [outcome.driveId] });
            return `drive=${outcome.driveId}`;
          },
        },
      ]);

    case 'park_drive':
      return linear([
        {
          step: 'park_sites',
          run: async () => {
            const outcome = await parkDriveSites(
              { driveId: row.targetId, source: 'takedown', caseId: row.id, createdBy: actor },
              publishedStore(),
            );
            await deps.cases.mergeSnapshot(row.id, { driveIds: [row.targetId] });
            return `prefixes=${outcome.prefixes.length} objects=${outcome.prefixes.reduce((n, p) => n + p.objects, 0)}`;
          },
        },
      ]);

    case 'avatar':
      return linear([
        { step: 'delete_avatar', run: () => deleteAvatarObjects(row.targetId) },
        { step: 'clear_profile_image', run: () => clearProfileImage(row.targetId) },
      ]);

    case 'park_user_sites': {
      let userSites: UserSitesOutcome | undefined;
      const result = await runLinearCase(
        row.id,
        [
          {
            step: 'park_sites',
            run: async () => {
              userSites = await parkUserSites({ userId: row.targetId, caseId: row.id, createdBy: actor }, publishedStore());
              await deps.cases.mergeSnapshot(row.id, {
                driveIds: userSites.parked.map((d) => d.driveId),
                skippedDrives: userSites.skipped,
              });
              return `parked=${userSites.parked.length} skipped=${userSites.skipped.length}`;
            },
          },
        ],
        deps,
      );
      return { result, userSites };
    }

    default:
      throw new TakedownRequestError(`Case ${row.id} has no takedown to run`, 409);
  }
}

function toResponse(action: TakedownRequest['action'], run: CaseRun): TakedownResponse {
  const { result, userSites } = run;
  return {
    action,
    caseId: result.caseId,
    status: result.status,
    ...(result.failedStep ? { failedStep: result.failedStep, error: result.error } : {}),
    ...(result.haltReason ? { haltReason: result.haltReason } : {}),
    ...(userSites
      ? { parkedDriveIds: userSites.parked.map((d) => d.driveId), skippedDrives: userSites.skipped }
      : {}),
  };
}

async function requireCase(caseId: string): Promise<ContentCase> {
  const row = await getContentCase(caseId);
  if (!row) throw new TakedownRequestError('Case not found', 404);
  return row;
}

/**
 * Execute a validated takedown request on behalf of an admin (or, with a null
 * actor, the system). Throws `TakedownRequestError` for a request that cannot
 * be acted on; a step that fails is NOT thrown — it comes back as
 * `{ status: 'open', failedStep }` with the case left resumable.
 */
export async function executeTakedown(request: TakedownRequest, actorUserId: string | null): Promise<TakedownResponse> {
  const deps = createTakedownDeps(actorUserId);
  const open = async (input: Parameters<typeof openTakedownCase>[0]): Promise<ContentCase> => {
    const opened = await openTakedownCase(input);
    if (opened.created) await alertOpened(opened.case, deps);
    return opened.case;
  };
  const actor = actorUserId ?? undefined;

  switch (request.action) {
    case 'global': {
      const contentHash = normalizeContentHash(request.contentHash);
      if (!contentHash) throw new TakedownRequestError('Invalid content hash', 400);
      const row = await open({
        targetType: 'content_hash',
        targetId: contentHash,
        contentHash,
        category: request.category,
        reason: request.reason,
        takedown: {
          kind: 'global',
          actorUserId: actor,
          skipPreservation: request.skipPreservation === true,
          skipPreservationReason: request.skipPreservationReason,
          suspendUploader: request.suspendUploader === true,
        },
      });
      return toResponse(request.action, await runCase(row, deps));
    }

    case 'unpublish_page': {
      const row = await open({
        targetType: 'page',
        targetId: request.pageId,
        category: request.category,
        reason: request.reason,
        takedown: { kind: 'unpublish_page', actorUserId: actor },
      });
      return toResponse(request.action, await runCase(row, deps));
    }

    case 'park_drive': {
      const row = await open({
        targetType: 'drive',
        targetId: request.driveId,
        category: request.category,
        reason: request.reason,
        takedown: { kind: 'park_drive', actorUserId: actor },
      });
      return toResponse(request.action, await runCase(row, deps));
    }

    case 'avatar': {
      const row = await open({
        targetType: 'avatar',
        targetId: request.userId,
        category: request.category,
        reason: request.reason,
        takedown: { kind: 'avatar', actorUserId: actor },
        snapshot: { uploaderUserId: request.userId },
      });
      return toResponse(request.action, await runCase(row, deps));
    }

    case 'park_user_sites': {
      const row = await open({
        targetType: 'user',
        targetId: request.userId,
        category: 'policy',
        reason: request.reason,
        takedown: { kind: 'park_user_sites', actorUserId: actor },
        snapshot: { uploaderUserId: request.userId },
      });
      return toResponse(request.action, await runCase(row, deps));
    }

    case 'restore_drive': {
      await restoreDriveSites(request.driveId, publishedStore());
      loggers.security.info('Content safety: drive sites restored', { driveId: request.driveId, actorUserId });
      return { action: request.action, restoredDriveIds: [request.driveId] };
    }

    case 'restore_user_sites': {
      const restored = await restoreUserSites(request.userId, publishedStore());
      return { action: request.action, restoredDriveIds: restored.map((d) => d.driveId) };
    }

    case 'resume': {
      const row = await requireCase(request.caseId);
      if (row.status === 'dismissed') throw new TakedownRequestError('A dismissed case cannot be resumed', 409);
      return toResponse(request.action, await runCase(row, deps));
    }

    case 'resweep': {
      const row = await requireCase(request.caseId);
      if (row.snapshot?.takedown?.kind !== 'global') {
        throw new TakedownRequestError('Only a global takedown can be re-swept', 409);
      }
      // A re-sweep runs the whole sequence from wherever it is. On a dismissed case
      // that would be a takedown nobody decided on; an unfinished one is resumed instead.
      if (row.status !== 'actioned') {
        throw new TakedownRequestError('Only a finished takedown can be re-swept; resume this case instead', 409);
      }
      return toResponse(request.action, { result: await resweepGlobalTakedown(row.id, deps) });
    }
  }
}
