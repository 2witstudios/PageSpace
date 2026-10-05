import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { reassignOwnerLeftAutomation } from '@pagespace/lib/organizations/automation-ownership';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { automationKindSchema, automationRefusalResponse, reassignAutomationSchema } from '@/lib/orgs/automation-ownership-route';
import { getNextRunDate } from '@/lib/workflows/cron-utils';

type Context = { params: Promise<{ orgId: string; kind: string; automationId: string }> };

/** The next fire of a reassigned scheduled workflow; an unschedulable expression leaves it unscheduled. */
function nextRunAt(cronExpression: string, timezone: string): Date | null {
  try {
    return getNextRunDate(cronExpression, timezone);
  } catch {
    return null;
  }
}

/**
 * POST /api/orgs/[orgId]/automations/[kind]/[automationId]/reassign — Owner and Admins hand an
 * automation whose creator left ([D-OW-36]) to an accepted member who can reach its drive. It is
 * switched back on and runs as them from then on, bounded by their caps ([D-OW-34]). Audited
 * org.automation.reassigned.
 */
export async function POST(request: Request, context: Context) {
  const { orgId, kind: rawKind, automationId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  const kind = automationKindSchema.safeParse(rawKind);
  if (!kind.success) return NextResponse.json({ error: 'Automation not found', code: 'not_found' }, { status: 404 });
  try {
    const parsed = reassignAutomationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues, code: 'invalid_request' }, { status: 400 });
    }
    const result = await reassignOwnerLeftAutomation({
      orgId,
      actorId: gate.userId,
      kind: kind.data,
      id: automationId,
      newOwnerId: parsed.data.newOwnerId,
      nextRunAt,
    });
    if (!result.ok) return automationRefusalResponse(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: kind.data,
      resourceId: automationId,
      details: { operation: 'reassign_owner_left_automation', orgId, newOwnerId: parsed.data.newOwnerId },
    });
    return NextResponse.json({ reassigned: true, newOwnerId: parsed.data.newOwnerId });
  } catch (error) {
    loggers.api.error('Error reassigning owner-left automation:', error as Error);
    return NextResponse.json({ error: 'Failed to reassign automation', code: 'internal_error' }, { status: 500 });
  }
}
