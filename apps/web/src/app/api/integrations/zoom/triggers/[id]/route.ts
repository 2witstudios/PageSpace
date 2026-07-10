import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { zoomConnections } from '@pagespace/db/schema/zoom';
import { webhookTriggers } from '@pagespace/db/schema/webhook-triggers';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const patchSchema = z.object({ isEnabled: z.boolean() });

// Returns the trigger only if it belongs to the caller's Zoom connection.
async function findOwnedTrigger(userId: string, triggerId: string) {
  const connection = await db.query.zoomConnections.findFirst({
    where: eq(zoomConnections.userId, userId),
    columns: { id: true },
  });
  if (!connection) return null;

  const trigger = await db.query.webhookTriggers.findFirst({
    where: and(
      eq(webhookTriggers.id, triggerId),
      eq(webhookTriggers.connectionId, connection.id),
    ),
  });
  return trigger ?? null;
}

// PATCH /api/integrations/zoom/triggers/[id] — toggle isEnabled
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;
    const { id } = await context.params;

    let body: unknown;
    try { body = await request.json(); } catch { body = {}; }
    const validation = patchSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid body', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const existing = await findOwnedTrigger(userId, id);
    if (!existing) return NextResponse.json({ error: 'Trigger not found' }, { status: 404 });

    const [trigger] = await db
      .update(webhookTriggers)
      .set({ isEnabled: validation.data.isEnabled })
      .where(eq(webhookTriggers.id, id))
      .returning();

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'zoom_webhook_trigger',
      resourceId: id,
      details: { operation: 'toggle', isEnabled: validation.data.isEnabled },
    });
    return NextResponse.json({ trigger });
  } catch (error) {
    loggers.api.error('Error updating Zoom webhook trigger', error as Error);
    return NextResponse.json({ error: 'Failed to update trigger' }, { status: 500 });
  }
}

// DELETE /api/integrations/zoom/triggers/[id] — hard delete
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;
    const { id } = await context.params;

    const existing = await findOwnedTrigger(userId, id);
    if (!existing) return NextResponse.json({ error: 'Trigger not found' }, { status: 404 });

    await db.delete(webhookTriggers).where(eq(webhookTriggers.id, id));

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'zoom_webhook_trigger',
      resourceId: id,
      details: { operation: 'delete' },
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    loggers.api.error('Error deleting Zoom webhook trigger', error as Error);
    return NextResponse.json({ error: 'Failed to delete trigger' }, { status: 500 });
  }
}
