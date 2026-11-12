import { NextResponse } from 'next/server';
import type { ContentTakedownKind } from '@pagespace/db/schema/content-safety';
import type { SecurityEventType } from '@pagespace/db/schema/security-audit';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getContentCase } from '@pagespace/lib/content-safety/case-store';
import { takedownRequestSchema, type TakedownRequest } from '@pagespace/lib/content-safety/takedown-request';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { withAdminAuth } from '@/lib/auth';
import { callWebTakedown } from '@/lib/content/web-takedown';

/**
 * POST /api/admin/content/takedown
 *
 * Every content-takedown action an admin can take: global (purge a hash for
 * every tenant), scoped (unpublish a page, park a drive's sites), avatar,
 * and resume / re-sweep of an existing case.
 *
 * This route authenticates the admin, validates the request and writes the
 * audit event; the takedown itself runs in the web app, which holds the S3
 * credentials (see lib/content/web-takedown.ts).
 *
 * Every attempt is audited with its outcome — including one the web app
 * refused or that could not be reached — under an event type of its own per
 * action.
 */

type AuditTarget = { eventType: SecurityEventType; resourceType: string; resourceId: string };

const KIND_EVENT: Record<ContentTakedownKind, SecurityEventType> = {
  global: 'content.takedown.global',
  unpublish_page: 'content.takedown.page_unpublished',
  park_drive: 'content.takedown.sites_parked',
  park_user_sites: 'content.takedown.sites_parked',
  avatar: 'content.takedown.avatar',
};
const RESTORED: SecurityEventType = 'content.takedown.sites_restored';

async function auditTargetFor(request: TakedownRequest): Promise<AuditTarget> {
  switch (request.action) {
    case 'global':
      return { eventType: KIND_EVENT.global, resourceType: 'file', resourceId: request.contentHash.toLowerCase() };
    case 'unpublish_page':
      return { eventType: KIND_EVENT.unpublish_page, resourceType: 'page', resourceId: request.pageId };
    case 'park_drive':
      return { eventType: KIND_EVENT.park_drive, resourceType: 'drive', resourceId: request.driveId };
    case 'restore_drive':
      return { eventType: RESTORED, resourceType: 'content_case', resourceId: request.caseId };
    case 'avatar':
      return { eventType: KIND_EVENT.avatar, resourceType: 'user', resourceId: request.userId };
    case 'park_user_sites':
      return { eventType: KIND_EVENT.park_user_sites, resourceType: 'user', resourceId: request.userId };
    case 'restore_user_sites':
      return { eventType: RESTORED, resourceType: 'user', resourceId: request.userId };
    case 'resweep':
      return { eventType: KIND_EVENT.global, resourceType: 'content_case', resourceId: request.caseId };
    case 'resume': {
      // A resume is the same action as the case it continues, so it is audited as that action.
      const kind = (await getContentCase(request.caseId))?.snapshot?.takedown?.kind ?? 'global';
      return { eventType: KIND_EVENT[kind], resourceType: 'content_case', resourceId: request.caseId };
    }
  }
}

/** The audited part of the request: the decision and its reason, never content. */
function auditDetailsFor(request: TakedownRequest): Record<string, unknown> {
  const { action } = request;
  return {
    action,
    ...('category' in request ? { category: request.category } : {}),
    ...('reason' in request ? { reason: request.reason } : {}),
    ...(action === 'global'
      ? {
          skipPreservation: request.skipPreservation === true,
          ...(request.skipPreservationReason ? { skipPreservationReason: request.skipPreservationReason } : {}),
          suspendUploader: request.suspendUploader === true,
        }
      : {}),
    ...('caseId' in request ? { caseId: request.caseId } : {}),
  };
}

export const POST = withAdminAuth(async (adminUser, request) => {
  const parsed = takedownRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid takedown request', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const takedown = parsed.data;

  if ((takedown.action === 'avatar' || takedown.action === 'park_user_sites') && takedown.userId === adminUser.id) {
    return NextResponse.json({ error: 'You cannot run this action on your own account' }, { status: 400 });
  }

  try {
    const target = await auditTargetFor(takedown);
    const result = await callWebTakedown(takedown, adminUser.id);

    auditRequest(request, {
      ...target,
      userId: adminUser.id,
      riskScore: 0.8,
      details: {
        source: 'admin',
        ...auditDetailsFor(takedown),
        ...(result.ok
          ? {
              outcome: result.body.failedStep
                ? 'step_failed'
                : (result.body.haltReason ?? (result.body.stillHeldDriveIds?.length ? 'hold_lifted_drive_still_held' : 'completed')),
              restoredDriveIds: result.body.restoredDriveIds,
              stillHeldDriveIds: result.body.stillHeldDriveIds,
              caseId: result.body.caseId ?? ('caseId' in takedown ? takedown.caseId : undefined),
              status: result.body.status,
              failedStep: result.body.failedStep,
            }
          : { outcome: 'not_run', upstreamStatus: result.status }),
      },
    });

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.body);
  } catch (error) {
    loggers.api.error('Error running content takedown', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to run takedown' }, { status: 500 });
  }
});
