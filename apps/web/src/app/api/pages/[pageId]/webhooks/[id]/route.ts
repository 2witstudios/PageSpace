import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { WEBHOOK_USERNAME_MAX_LENGTH } from '@pagespace/lib/services/page-webhook-core';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateRequestWithOptions, isAuthError, canManagePageWebhooks } from '@/lib/auth';

const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const patchSchema = z.object({
  isEnabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(WEBHOOK_USERNAME_MAX_LENGTH).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' });

function toPublicWebhook(row: typeof pageWebhooks.$inferSelect) {
  const { webhookSecretEncrypted: _webhookSecretEncrypted, ...publicRow } = row;
  return publicRow;
}

async function findOwnedWebhook(pageId: string, id: string) {
  const row = await db.query.pageWebhooks.findFirst({
    where: and(eq(pageWebhooks.id, id), eq(pageWebhooks.pageId, pageId)),
  });
  return row ?? null;
}

// PATCH /api/pages/[pageId]/webhooks/[id] — toggle/rename a webhook
export async function PATCH(request: Request, context: { params: Promise<{ pageId: string; id: string }> }) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;
    const { pageId, id } = await context.params;

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

    const existing = await findOwnedWebhook(pageId, id);
    if (!existing) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });

    const [row] = await db
      .update(pageWebhooks)
      .set(validation.data)
      .where(eq(pageWebhooks.id, id))
      .returning();

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'page_webhook',
      resourceId: id,
      details: { operation: 'update', pageId, ...validation.data },
    });
    return NextResponse.json({ webhook: toPublicWebhook(row) });
  } catch (error) {
    loggers.api.error('Error updating page webhook', error as Error);
    return NextResponse.json({ error: 'Failed to update webhook' }, { status: 500 });
  }
}

// DELETE /api/pages/[pageId]/webhooks/[id] — revoke a webhook
export async function DELETE(request: Request, context: { params: Promise<{ pageId: string; id: string }> }) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;
    const { pageId, id } = await context.params;

    const canManage = await canManagePageWebhooks(auth, pageId);
    if (!canManage) {
      return NextResponse.json({ error: 'Only the drive owner or an admin can manage page webhooks' }, { status: 403 });
    }

    const existing = await findOwnedWebhook(pageId, id);
    if (!existing) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });

    await db.delete(pageWebhooks).where(eq(pageWebhooks.id, id));

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'page_webhook',
      resourceId: id,
      details: { operation: 'delete', pageId },
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    loggers.api.error('Error deleting page webhook', error as Error);
    return NextResponse.json({ error: 'Failed to delete webhook' }, { status: 500 });
  }
}
