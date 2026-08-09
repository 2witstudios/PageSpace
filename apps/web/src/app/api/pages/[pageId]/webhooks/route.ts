import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { encryptField } from '@pagespace/lib/encryption/field-crypto';
import { WEBHOOK_USERNAME_MAX_LENGTH } from '@pagespace/lib/services/page-webhook-core';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateRequestWithOptions, isAuthError, canManagePageWebhooks } from '@/lib/auth';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

// The webhook name doubles as the default sender name, so it shares the
// sender-name cap from the pure core.
const createSchema = z.object({
  name: z.string().trim().min(1).max(WEBHOOK_USERNAME_MAX_LENGTH),
});

/** Strip the encrypted secret from every response — it is returned in plaintext exactly once, at creation. */
function toPublicWebhook(row: typeof pageWebhooks.$inferSelect) {
  const { webhookSecretEncrypted: _webhookSecretEncrypted, ...publicRow } = row;
  return publicRow;
}

// GET /api/pages/[pageId]/webhooks — list a page's incoming webhooks
export async function GET(request: Request, context: { params: Promise<{ pageId: string }> }) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const { pageId } = await context.params;

    const canManage = await canManagePageWebhooks(auth, pageId);
    if (!canManage) {
      return NextResponse.json({ error: 'Only the drive owner or an admin can manage page webhooks' }, { status: 403 });
    }

    const rows = await db.query.pageWebhooks.findMany({
      where: eq(pageWebhooks.pageId, pageId),
      limit: 100,
    });

    return NextResponse.json({ webhooks: rows.map(toPublicWebhook) });
  } catch (error) {
    loggers.api.error('Error listing page webhooks', error as Error);
    return NextResponse.json({ error: 'Failed to list webhooks' }, { status: 500 });
  }
}

// POST /api/pages/[pageId]/webhooks — mint a new incoming webhook for a page
export async function POST(request: Request, context: { params: Promise<{ pageId: string }> }) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;
    const { pageId } = await context.params;

    const canManage = await canManagePageWebhooks(auth, pageId);
    if (!canManage) {
      return NextResponse.json({ error: 'Only the drive owner or an admin can manage page webhooks' }, { status: 403 });
    }

    // Any page type may mint a webhook — what a delivery *does* is a dispatch
    // decision at intake time, not a minting restriction. Trashed pages are the
    // one exception: no new unattended write paths into the trash.
    const page = await db.query.pages.findFirst({ where: eq(pages.id, pageId), columns: { isTrashed: true } });
    if (!page) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    if (page.isTrashed) {
      return NextResponse.json({ error: 'Webhooks cannot be attached to a trashed page' }, { status: 400 });
    }

    let body: unknown;
    try { body = await request.json(); } catch { body = {}; }
    const validation = createSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid webhook', details: validation.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const webhookSecretPlaintext = randomBytes(32).toString('base64url');
    const webhookSecretEncrypted = await encryptField(webhookSecretPlaintext);

    const [row] = await db
      .insert(pageWebhooks)
      .values({ pageId, name: validation.data.name, webhookSecretEncrypted, createdBy: userId })
      .returning();

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'page_webhook',
      resourceId: row.id,
      details: { operation: 'create', pageId },
    });

    return NextResponse.json({
      webhook: toPublicWebhook(row),
      // Returned exactly once — the plaintext secret is never persisted or re-derivable after this response.
      webhookSecret: webhookSecretPlaintext,
    }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating page webhook', error as Error);
    return NextResponse.json({ error: 'Failed to create webhook' }, { status: 500 });
  }
}
