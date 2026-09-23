import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { changeOrgDriveLead } from '@pagespace/lib/services/org-drive-service';
import { orgDriveServiceDeps } from '@pagespace/lib/services/org-drive-service-deps';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { recordOrgPowerDriveAction } from '@pagespace/lib/permissions/drive-relationship-loader';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { safeParseBody } from '@/lib/validation/parse-body';

/**
 * PUT /api/drives/[driveId]/org/lead — hand an org drive to a new lead (Spec DRV-1, D-OW-7).
 *
 * The current lead or an org Owner or Admin names an org member. drives.ownerId and the former
 * lead's OWNER row move together in one transaction; each person keeps only their own membership,
 * and both are told in realtime.
 *
 * Session only: CLI and MCP parity is Wave G (X-1). Dark while ORGS_ENABLED is false.
 */

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const leadSchema = z.object({
  userId: z.string().min(1),
}).strict();

type RouteContext = { params: Promise<{ driveId: string }> };

export async function PUT(request: Request, context: RouteContext) {
  if (!ORGS_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const parsed = await safeParseBody(request, leadSchema);
  if (!parsed.success) return parsed.response;

  try {
    const result = await changeOrgDriveLead(auth.userId, driveId, { newLeadId: parsed.data.userId }, orgDriveServiceDeps);
    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
    }
    if (!result.changed) return NextResponse.json({ drive: result.drive });

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { operation: 'org_drive_lead_change', orgId: result.drive.orgId, fromUserId: result.fromUserId, toUserId: result.toUserId },
    });
    // ORG-4: judged on the drive as it was, so an org Admin who made themselves lead is still audited.
    await recordOrgPowerDriveAction(auth.userId, { ...result.drive, ownerId: result.fromUserId }, 'change_lead');

    try {
      const recipients = await getDriveRecipientUserIds(driveId);
      await broadcastDriveEvent(
        createDriveEventPayload(driveId, 'updated', { name: result.drive.name, slug: result.drive.slug }),
        recipients
      );
    } catch (error) {
      loggers.api.warn('Drive lead changed but the drive update broadcast failed', {
        driveId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return NextResponse.json({ drive: result.drive });
  } catch (error) {
    loggers.api.error('Error changing the drive lead:', error as Error);
    return NextResponse.json({ error: 'Failed to change the drive lead' }, { status: 500 });
  }
}
