import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ORG_DRIVE_VISIBILITIES } from '@pagespace/db/schema/core';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { moveDriveOutOfOrg, moveDriveToOrg, type MoveDriveResult } from '@pagespace/lib/services/org-drive-service';
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

  const recipients = await getDriveRecipientUserIds(driveId);
  await broadcastDriveEvent(
    createDriveEventPayload(driveId, 'updated', { name: result.drive.name, slug: result.drive.slug }),
    recipients
  );

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
