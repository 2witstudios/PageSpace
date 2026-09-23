import { NextResponse } from 'next/server';
import { z } from 'zod';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { answerDriveJoinRequest, withdrawDriveJoinRequest } from '@pagespace/lib/services/drive-join-request-service';
import { recordOrgPowerDriveAction } from '@pagespace/lib/permissions/drive-relationship-loader';
import { authenticateOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { orgRefusalResponse } from '@/lib/orgs/org-refusal-response';
import { safeParseBody } from '@/lib/validation/parse-body';

/**
 * One join request on a Restricted org drive (Spec DRV-6, D-OW-22).
 *
 * PATCH  approve or deny: the drive lead or an org Owner/Admin, never on their own request.
 *        Approval is the only path from a request to membership.
 * DELETE withdraw: the requester only.
 *
 * Session only: CLI and MCP parity is Wave G (X-1). Dark while ORGS_ENABLED is false.
 */

const answerSchema = z.object({
  decision: z.enum(['approve', 'deny']),
}).strict();

type RouteContext = { params: Promise<{ driveId: string; requestId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const { driveId, requestId } = await context.params;
  const gate = await authenticateOrgRequest(request, ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;

  const parsed = await safeParseBody(request, answerSchema);
  if (!parsed.success) return parsed.response;

  try {
    const result = await answerDriveJoinRequest(gate.userId, driveId, requestId, parsed.data.decision);
    if (!result.ok) return orgRefusalResponse(result);

    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'drive_join_request',
      resourceId: requestId,
      details: {
        operation: result.action === 'approve' ? 'drive_join_request_approve' : 'drive_join_request_deny',
        driveId,
        orgId: result.drive.orgId,
        requesterId: result.request.userId,
        admitted: result.admitted,
      },
    });
    // ORG-4: answering through org Owner/Admin power rather than as the lead is audited too.
    await recordOrgPowerDriveAction(gate.userId, result.drive, 'answer_join_request');

    return NextResponse.json({ request: result.request, admitted: result.admitted });
  } catch (error) {
    loggers.api.error('Error answering a drive join request:', error as Error);
    return NextResponse.json({ error: 'Failed to answer the join request' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const { driveId, requestId } = await context.params;
  const gate = await authenticateOrgRequest(request, ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;

  try {
    const result = await withdrawDriveJoinRequest(gate.userId, driveId, requestId);
    if (!result.ok) return orgRefusalResponse(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'drive_join_request',
      resourceId: requestId,
      details: { operation: 'drive_join_request_withdraw', driveId },
    });
    return NextResponse.json({ request: result.request });
  } catch (error) {
    loggers.api.error('Error withdrawing a drive join request:', error as Error);
    return NextResponse.json({ error: 'Failed to withdraw the join request' }, { status: 500 });
  }
}
