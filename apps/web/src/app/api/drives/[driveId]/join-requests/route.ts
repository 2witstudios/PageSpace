import { NextResponse } from 'next/server';
import { z } from 'zod';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  JOIN_REQUEST_MESSAGE_MAX,
  listPendingDriveJoinRequests,
  requestToJoinDrive,
} from '@pagespace/lib/services/drive-join-request-service';
import { authenticateOrgRequest, ORG_READ_AUTH, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { orgRefusalResponse } from '@/lib/orgs/org-refusal-response';
import { safeParseBody } from '@/lib/validation/parse-body';

/**
 * Join requests for a Restricted org drive (Spec DRV-6, D-OW-22).
 *
 * GET  the pending requests, for the drive lead or an org Owner/Admin.
 * POST ask to join; idempotent while a request is open. A request grants nothing until approved.
 *
 * Session only: CLI and MCP parity is Wave G (X-1). Dark while ORGS_ENABLED is false.
 */

const requestSchema = z.object({
  message: z.string().max(JOIN_REQUEST_MESSAGE_MAX).optional(),
}).strict();

type RouteContext = { params: Promise<{ driveId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { driveId } = await context.params;
  const gate = await authenticateOrgRequest(request, ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const result = await listPendingDriveJoinRequests(gate.userId, driveId);
    if (!result.ok) return orgRefusalResponse(result);
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'drive_join_requests',
      resourceId: driveId,
      details: { operation: 'list_drive_join_requests', count: result.requests.length },
    });
    return NextResponse.json({ requests: result.requests });
  } catch (error) {
    loggers.api.error('Error listing drive join requests:', error as Error);
    return NextResponse.json({ error: 'Failed to list join requests' }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { driveId } = await context.params;
  const gate = await authenticateOrgRequest(request, ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;

  const parsed = await safeParseBody(request, requestSchema);
  if (!parsed.success) return parsed.response;

  try {
    const result = await requestToJoinDrive(gate.userId, driveId, { message: parsed.data.message });
    if (!result.ok) return orgRefusalResponse(result);
    if (result.created) {
      auditRequest(request, {
        eventType: 'data.write',
        userId: gate.userId,
        resourceType: 'drive_join_request',
        resourceId: result.request.id,
        details: { operation: 'drive_join_request', driveId, orgId: result.drive.orgId },
      });
    }
    return NextResponse.json({ request: result.request }, { status: result.created ? 201 : 200 });
  } catch (error) {
    loggers.api.error('Error requesting to join a drive:', error as Error);
    return NextResponse.json({ error: 'Failed to request to join' }, { status: 500 });
  }
}
