import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { deleteOwnerLeftAutomation } from '@pagespace/lib/organizations/automation-ownership';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { automationKindSchema, automationRefusalResponse } from '@/lib/orgs/automation-ownership-route';

type Context = { params: Promise<{ orgId: string; kind: string; automationId: string }> };

/**
 * DELETE /api/orgs/[orgId]/automations/[kind]/[automationId] — Owner and Admins delete an automation
 * whose creator left ([D-OW-36]); a workflow takes its triggers with it. Audited org.automation.deleted.
 */
export async function DELETE(request: Request, context: Context) {
  const { orgId, kind: rawKind, automationId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  const kind = automationKindSchema.safeParse(rawKind);
  if (!kind.success) return NextResponse.json({ error: 'Automation not found', code: 'not_found' }, { status: 404 });
  try {
    const result = await deleteOwnerLeftAutomation({ orgId, actorId: gate.userId, kind: kind.data, id: automationId });
    if (!result.ok) return automationRefusalResponse(result);
    auditRequest(request, {
      eventType: 'data.delete',
      userId: gate.userId,
      resourceType: kind.data,
      resourceId: automationId,
      details: { operation: 'delete_owner_left_automation', orgId },
    });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    loggers.api.error('Error deleting owner-left automation:', error as Error);
    return NextResponse.json({ error: 'Failed to delete automation', code: 'internal_error' }, { status: 500 });
  }
}
