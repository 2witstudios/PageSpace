import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ORG_DRIVE_VISIBILITIES } from '@pagespace/db/schema/core';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import {
  changeDriveVisibility,
  moveDriveOutOfOrg,
  moveDriveToOrg,
  type MoveDriveResult,
} from '@pagespace/lib/services/org-drive-service';
import { recordOrgPowerDriveAction } from '@pagespace/lib/permissions/drive-relationship-loader';
import { orgDriveServiceDeps } from '@pagespace/lib/services/org-drive-service-deps';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { safeParseBody } from '@/lib/validation/parse-body';

/**
 * Org ownership of a drive (Spec DRV-2, O-10).
 *
 * PUT    moves a personal drive into an org: its owner only, who must be an org member.
 * DELETE moves an org drive out: an org Owner or Admin, choosing whether org members keep
 *        access as invited members or are removed.
 * PATCH  changes an org drive's visibility (DRV-4): its lead or an org Owner or Admin. The org
 *        membership sync runs in the same transaction, so materialized rows follow.
 *
 * Session only: CLI and MCP parity is Wave G (X-1). Dark while ORGS_ENABLED is false.
 */

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const moveInSchema = z.object({
  orgId: z.string().min(1),
  orgVisibility: z.enum(ORG_DRIVE_VISIBILITIES).optional(),
}).strict();

const moveOutSchema = z.object({
  implicitMembers: z.enum(['keep', 'remove']),
}).strict();

const visibilitySchema = z.object({
  orgVisibility: z.enum(ORG_DRIVE_VISIBILITIES),
}).strict();

type RouteContext = { params: Promise<{ driveId: string }> };

async function respond(
  request: Request,
  userId: string,
  driveId: string,
  result: MoveDriveResult,
  operation: 'org_move_in' | 'org_move_out'
) {
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId,
    resourceType: 'drive',
    resourceId: driveId,
    details: { operation, orgId: result.orgId, storageReattribution: result.storageReattribution.status },
  });

  // The move has committed: notifying the sidebar is best-effort and never turns it into a 500.
  try {
    const recipients = await getDriveRecipientUserIds(driveId);
    await broadcastDriveEvent(
      createDriveEventPayload(driveId, 'updated', { name: result.drive.name, slug: result.drive.slug }),
      recipients
    );
  } catch (error) {
    loggers.api.warn('Org drive move committed but the drive update broadcast failed', {
      driveId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return NextResponse.json({ drive: result.drive, storageReattribution: result.storageReattribution });
}

export async function PUT(request: Request, context: RouteContext) {
  if (!ORGS_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const parsed = await safeParseBody(request, moveInSchema);
  if (!parsed.success) return parsed.response;

  try {
    const result = await moveDriveToOrg(auth.userId, driveId, parsed.data, orgDriveServiceDeps);
    return await respond(request, auth.userId, driveId, result, 'org_move_in');
  } catch (error) {
    loggers.api.error('Error moving drive into organization:', error as Error);
    return NextResponse.json({ error: 'Failed to move drive into organization' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!ORGS_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const parsed = await safeParseBody(request, moveOutSchema);
  if (!parsed.success) return parsed.response;

  try {
    const result = await moveDriveOutOfOrg(auth.userId, driveId, parsed.data, orgDriveServiceDeps);
    return await respond(request, auth.userId, driveId, result, 'org_move_out');
  } catch (error) {
    loggers.api.error('Error moving drive out of organization:', error as Error);
    return NextResponse.json({ error: 'Failed to move drive out of organization' }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!ORGS_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const parsed = await safeParseBody(request, visibilitySchema);
  if (!parsed.success) return parsed.response;

  try {
    const result = await changeDriveVisibility(auth.userId, driveId, parsed.data, orgDriveServiceDeps);
    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
    }
    if (!result.changed) return NextResponse.json({ drive: result.drive });

    // AUD-1: a visibility change is an org-scoped event.
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { operation: 'org_visibility_change', orgId: result.drive.orgId, from: result.from, to: result.to },
    });
    // ORG-4: a change made through org Owner/Admin power rather than as the lead is audited too.
    await recordOrgPowerDriveAction(auth.userId, result.drive, 'change_visibility');

    // The change has committed: the sync already told each affected member; the drive update
    // broadcast is best-effort and never turns it into a 500.
    try {
      const recipients = await getDriveRecipientUserIds(driveId);
      await broadcastDriveEvent(
        createDriveEventPayload(driveId, 'updated', { name: result.drive.name, slug: result.drive.slug }),
        recipients
      );
    } catch (error) {
      loggers.api.warn('Drive visibility changed but the drive update broadcast failed', {
        driveId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return NextResponse.json({ drive: result.drive });
  } catch (error) {
    loggers.api.error('Error changing drive visibility:', error as Error);
    return NextResponse.json({ error: 'Failed to change drive visibility' }, { status: 500 });
  }
}
