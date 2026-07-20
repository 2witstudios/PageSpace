import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { webhookTriggers } from '@pagespace/db/schema/webhook-triggers';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateRequestWithOptions, isAuthError, canManagePageWebhooks } from '@/lib/auth';

const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const patchSchema = z.object({ isEnabled: z.boolean() });

// Returns the trigger only if it is anchored to a webhook owned by this page —
// scopes toggle/delete to a trigger the caller's page controls.
async function findOwnedTrigger(pageId: string, webhookId: string, triggerId: string) {
  const webhook = await db.query.pageWebhooks.findFirst({
    where: and(eq(pageWebhooks.id, webhookId), eq(pageWebhooks.pageId, pageId)),
    columns: { id: true },
  });
  if (!webhook) return null;

  const trigger = await db.query.webhookTriggers.findFirst({
    where: and(
      eq(webhookTriggers.id, triggerId),
      eq(webhookTriggers.pageWebhookId, webhookId),
    ),
  });
  return trigger ?? null;
}

// PATCH /api/pages/[pageId]/webhooks/[id]/triggers/[triggerId] — toggle isEnabled
export async function PATCH(
  request: Request,
  context: { params: Promise<{ pageId: string; id: string; triggerId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;
    const { pageId, id, triggerId } = await context.params;

    const canManage = await canManagePageWebhooks(auth, pageId);
    if (!canManage) {
      return NextResponse.json({ error: 'Only the drive owner or an admin can manage page webhooks' }, { status: 403 });
    }

    let body: unknown;
    try { body = await request.json(); } catch { body = {}; }
    const validation = patchSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid body', details: validation.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const existing = await findOwnedTrigger(pageId, id, triggerId);
    if (!existing) return NextResponse.json({ error: 'Trigger not found' }, { status: 404 });

    const [trigger] = await db
      .update(webhookTriggers)
      .set({ isEnabled: validation.data.isEnabled })
      .where(eq(webhookTriggers.id, triggerId))
      .returning();

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'webhook_trigger',
      resourceId: triggerId,
      details: { operation: 'toggle', pageId, pageWebhookId: id, isEnabled: validation.data.isEnabled },
    });
    return NextResponse.json({ trigger });
  } catch (error) {
    loggers.api.error('Error updating page webhook trigger', error as Error);
    return NextResponse.json({ error: 'Failed to update trigger' }, { status: 500 });
  }
}

// DELETE /api/pages/[pageId]/webhooks/[id]/triggers/[triggerId] — detach a workflow
export async function DELETE(
  request: Request,
  context: { params: Promise<{ pageId: string; id: string; triggerId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;
    const { pageId, id, triggerId } = await context.params;

    const canManage = await canManagePageWebhooks(auth, pageId);
    if (!canManage) {
      return NextResponse.json({ error: 'Only the drive owner or an admin can manage page webhooks' }, { status: 403 });
    }

    const existing = await findOwnedTrigger(pageId, id, triggerId);
    if (!existing) return NextResponse.json({ error: 'Trigger not found' }, { status: 404 });

    await db.delete(webhookTriggers).where(eq(webhookTriggers.id, triggerId));

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'webhook_trigger',
      resourceId: triggerId,
      details: { operation: 'delete', pageId, pageWebhookId: id },
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    loggers.api.error('Error deleting page webhook trigger', error as Error);
    return NextResponse.json({ error: 'Failed to delete trigger' }, { status: 500 });
  }
}
