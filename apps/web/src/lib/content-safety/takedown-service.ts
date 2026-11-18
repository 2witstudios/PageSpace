import 'server-only';

import { db } from '@pagespace/db/db';
import { and, eq, isNotNull } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import type { ContentCase } from '@pagespace/db/schema/content-safety';
import { audit } from '@pagespace/lib/audit/audit-log';
import { suspendUser } from '@pagespace/lib/auth/suspend-user';
import { sendContentSafetyAlert } from '@pagespace/lib/content-safety/alerts';
import {
  CaseCategoryDowngradeError,
  CaseRunInProgressError,
  createTakedownCaseStore,
  getContentCase,
  openTakedownCase,
  type OpenTakedownCaseInput,
} from '@pagespace/lib/content-safety/case-store';
import { normalizeContentHash } from '@pagespace/lib/content-safety/policy';
import {
  avatarTakedownPlan,
  resweepGlobalTakedown,
  runGlobalTakedown,
  runLinearCase,
  safeAlert,
  sweepPublicIfUnfinished,
  type LinearStep,
  type PublicSweepResult,
  type TakedownDeps,
  type TakedownRunResult,
} from '@pagespace/lib/content-safety/takedown';
import type { TakedownRequest, TakedownResponse } from '@pagespace/lib/content-safety/takedown-request';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  UserStillSuspendedError,
  parkDriveSites,
  parkUserSites,
  releaseDriveHold,
  restoreUserSites,
  type ReleaseHoldOutcome,
  type UserSitesOutcome,
} from '@pagespace/lib/organizations/published-visibility';
import { RESTORE_SITES_STEP } from '@pagespace/lib/content-safety/takedown-plan';
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
              { driveId: row.targetId, holder: { caseId: row.id }, createdBy: actor },
              publishedStore(),
            );
            await deps.cases.mergeSnapshot(row.id, { driveIds: [row.targetId] });
            return `prefixes=${outcome.prefixes.length} objects=${outcome.prefixes.reduce((n, p) => n + p.objects, 0)}`;
          },
        },
      ]);

    case 'avatar':
      // Preserved to evidence before anything is deleted; CSAM with no evidence storage stops at awaiting_evidence.
      return linear(
        avatarTakedownPlan(row, deps, {
          deleteAvatar: () => deleteAvatarObjects(row.targetId),
          clearProfileImage: () => clearProfileImage(row.targetId),
        }),
      );

    case 'park_user_sites': {
      let userSites: UserSitesOutcome | undefined;
      const result = await runLinearCase(
        row.id,
        [
          {
            step: 'park_sites',
            run: async () => {
              userSites = await parkUserSites({ userId: row.targetId, createdBy: actor }, publishedStore());
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
    ...(result.inProgress ? { inProgress: true } : {}),
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

type CaseOpeningRequest = Extract<TakedownRequest, { action: 'global' | 'unpublish_page' | 'park_drive' | 'avatar' | 'park_user_sites' }>;

/** The case a request opens: its target, and the takedown it will run. Pure. */
function caseInputFor(request: CaseOpeningRequest, actorUserId: string | undefined): OpenTakedownCaseInput {
  const { reason } = request;
  switch (request.action) {
    case 'global': {
      const contentHash = normalizeContentHash(request.contentHash);
      if (!contentHash) throw new TakedownRequestError('Invalid content hash', 400);
      return {
        targetType: 'content_hash',
        targetId: contentHash,
        contentHash,
        category: request.category,
        reason,
        takedown: {
          kind: 'global',
          actorUserId,
          skipPreservation: request.skipPreservation === true,
          skipPreservationReason: request.skipPreservationReason,
          suspendUploader: request.suspendUploader === true,
        },
      };
    }
    case 'unpublish_page':
      return { targetType: 'page', targetId: request.pageId, category: request.category, reason, takedown: { kind: 'unpublish_page', actorUserId } };
    case 'park_drive':
      return { targetType: 'drive', targetId: request.driveId, category: request.category, reason, takedown: { kind: 'park_drive', actorUserId } };
    case 'avatar':
      return {
        targetType: 'avatar',
        targetId: request.userId,
        category: request.category,
        reason,
        takedown: { kind: 'avatar', actorUserId },
        snapshot: { uploaderUserId: request.userId },
      };
    case 'park_user_sites':
      return {
        targetType: 'user',
        targetId: request.userId,
        category: 'policy',
        reason,
        takedown: { kind: 'park_user_sites', actorUserId },
        snapshot: { uploaderUserId: request.userId },
      };
  }
}

/**
 * Execute a validated takedown request on behalf of an admin (or, with a null
 * actor, the system). Throws `TakedownRequestError` for a request that cannot
 * be acted on; a step that fails is NOT thrown — it comes back as
 * `{ status: 'open', failedStep }` with the case left resumable.
 */
export async function executeTakedown(request: TakedownRequest, actorUserId: string | null): Promise<TakedownResponse> {
  const deps = createTakedownDeps(actorUserId);

  switch (request.action) {
    case 'global':
    case 'unpublish_page':
    case 'park_drive':
    case 'avatar':
    case 'park_user_sites': {
      let opened: Awaited<ReturnType<typeof openTakedownCase>>;
      try {
        opened = await openTakedownCase(caseInputFor(request, actorUserId ?? undefined));
      } catch (error) {
        if (error instanceof CaseCategoryDowngradeError || error instanceof CaseRunInProgressError) {
          throw new TakedownRequestError(error.message, 409);
        }
        throw error;
      }
      if (opened.created) {
        await safeAlert(deps, { event: 'opened', caseId: opened.case.id, category: opened.case.category });
      }
      return toResponse(request.action, await runCase(opened.case, deps));
    }

    case 'restore_drive': {
      // Lifts only the hold THIS case placed. If another case or the owner's
      // suspension also holds the drive, it stays parked and the response says so.
      const row = await requireCase(request.caseId);
      if (row.snapshot?.takedown?.kind !== 'park_drive') {
        throw new TakedownRequestError('Only a drive-parking case has a hold to lift', 409);
      }
      const driveId = row.targetId;
      const released = await releaseDriveHold({ driveId, holder: { caseId: row.id } }, publishedStore());
      if (!released.released) throw new TakedownRequestError('This case no longer holds the drive', 409);

      await deps.cases.appendStep(row.id, {
        step: RESTORE_SITES_STEP,
        status: 'ok',
        detail: `remaining_holds=${released.remainingHolds}`,
        at: new Date().toISOString(),
      });
      await deps.cases.mergeSnapshot(row.id, { restore: { actorUserId: actorUserId ?? undefined, reason: request.reason } });
      loggers.security.info('Content safety: drive hold lifted', { caseId: row.id, driveId, actorUserId, remainingHolds: released.remainingHolds });
      return {
        action: request.action,
        caseId: row.id,
        status: row.status,
        ...(released.remainingHolds === 0 ? { restoredDriveIds: [driveId] } : { restoredDriveIds: [], stillHeldDriveIds: [driveId] }),
      };
    }

    case 'restore_user_sites': {
      let released: ReleaseHoldOutcome[];
      try {
        released = await restoreUserSites(request.userId, publishedStore());
      } catch (error) {
        if (error instanceof UserStillSuspendedError) throw new TakedownRequestError(error.message, 409);
        throw error;
      }
      return {
        action: request.action,
        restoredDriveIds: released.filter((d) => d.remainingHolds === 0).map((d) => d.driveId),
        stillHeldDriveIds: released.filter((d) => d.remainingHolds > 0).map((d) => d.driveId),
      };
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
      // that would be a takedown nobody decided on, and a case that never finished
      // is resumed instead. The one unfinished case that IS swept is one a failed
      // re-sweep left open: sweeping again continues that pass.
      const failedResweep = row.status === 'open' && (row.snapshot?.resweep?.attempts ?? 0) > 0;
      if (row.status !== 'actioned' && !failedResweep) {
        throw new TakedownRequestError('Only a finished takedown can be re-swept; resume this case instead', 409);
      }
      return toResponse(request.action, { result: await resweepGlobalTakedown(row.id, deps) });
    }
  }
}

/**
 * The re-sweep cron's public pass over one case: if it is an unfinished global takedown whose hash is blocked, take its public copies
 * offline again (a publish in flight at the block can have put one back). Nothing else runs.
 */
export async function sweepPublicForUnfinishedCase(caseId: string): Promise<PublicSweepResult> {
  return sweepPublicIfUnfinished(caseId, createTakedownDeps(null));
}

/**
 * Stop showing a user's avatar without deleting it: clears the profile image.
 * The objects stay, and their URL still answers. The backfill uses this only
 * when the avatar's bytes could not be preserved yet, and retries the delete.
 */
export async function hideUserAvatar(userId: string): Promise<void> {
  await clearProfileImage(userId);
}

/**
 * Take a user's avatar off the web without opening a takedown case: the
 * backfill does this, under enforce, for an avatar the classifier flagged (the
 * review case is already open for its hash), and for a blocklisted avatar once
 * its bytes are staged. Deletes the objects, checks none are left, and clears
 * the profile image.
 */
export async function removeUserAvatar(userId: string): Promise<void> {
  // The profile first: if the delete then fails, the stored avatar is still listed and the next tick retries the
  // removal (the backfill re-checks it is the same avatar). The other order would leave a profile image pointing
  // at deleted objects with nothing left to list.
  await clearProfileImage(userId);
  await deleteAvatarObjects(userId);
}
