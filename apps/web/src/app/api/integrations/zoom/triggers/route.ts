import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { zoomConnections } from '@pagespace/db/schema/zoom';
import { webhookTriggers } from '@pagespace/db/schema/webhook-triggers';
import { workflows } from '@pagespace/db/schema/workflows';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { ZOOM_TRIGGER_EVENT_TYPES } from '@/lib/integrations/zoom/webhook-event-types';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const createSchema = z.object({
  workflowId: z.string().min(1),
  eventType: z.enum(ZOOM_TRIGGER_EVENT_TYPES),
});

// GET /api/integrations/zoom/triggers — list triggers for the caller's connection
export async function GET(request: Request) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const connection = await db.query.zoomConnections.findFirst({
      where: eq(zoomConnections.userId, userId),
      columns: { id: true },
    });
    if (!connection) return NextResponse.json({ error: 'No connection found' }, { status: 404 });

    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    const triggers = await db.query.webhookTriggers.findMany({
      where: eq(webhookTriggers.connectionId, connection.id),
    });

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'zoom_webhook_trigger', resourceId: 'self' });
    return NextResponse.json({ triggers });
  } catch (error) {
    loggers.api.error('Error listing Zoom webhook triggers', error as Error);
    return NextResponse.json({ error: 'Failed to list triggers' }, { status: 500 });
  }
}

// POST /api/integrations/zoom/triggers — wire a workflow to a Zoom event
export async function POST(request: Request) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    let body: unknown;
    try { body = await request.json(); } catch { body = {}; }
    const validation = createSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid trigger', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const { workflowId, eventType } = validation.data;

    const connection = await db.query.zoomConnections.findFirst({
      where: eq(zoomConnections.userId, userId),
      columns: { id: true },
    });
    if (!connection) return NextResponse.json({ error: 'No connection found' }, { status: 404 });

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
      columns: { id: true, driveId: true },
    });
    if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

    const access = await checkDriveAccess(workflow.driveId, userId);
    if (!access.drive) return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can manage triggers' }, { status: 403 });
    }

    // Idempotent create: the (connectionId, workflowId, eventType) unique
    // constraint makes repeated POSTs no-ops rather than duplicate rows.
    const [inserted] = await db
      .insert(webhookTriggers)
      .values({ workflowId, connectionId: connection.id, provider: 'zoom', eventType })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      const existing = await db.query.webhookTriggers.findFirst({
        where: and(
          eq(webhookTriggers.connectionId, connection.id),
          eq(webhookTriggers.workflowId, workflowId),
          eq(webhookTriggers.eventType, eventType),
        ),
      });
      return NextResponse.json({ trigger: existing }, { status: 200 });
    }

    loggers.api.info('Zoom webhook trigger created', { userId, workflowId, eventType });
    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'zoom_webhook_trigger',
      resourceId: inserted.id,
      details: { operation: 'create', workflowId, eventType },
    });
    return NextResponse.json({ trigger: inserted }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating Zoom webhook trigger', error as Error);
    return NextResponse.json({ error: 'Failed to create trigger' }, { status: 500 });
  }
}
