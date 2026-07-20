import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { and, eq, asc, count } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { webhookTriggers, PAGE_WEBHOOK_EVENT_TYPE } from '@pagespace/db/schema/webhook-triggers';
import { workflows } from '@pagespace/db/schema/workflows';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateRequestWithOptions, isAuthError, canManagePageWebhooks } from '@/lib/auth';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

// Page webhooks skip event matching (every enabled trigger fires), so the only
// binding input is which workflow to run.
const createSchema = z.object({
  workflowId: z.string().min(1),
});

// A page webhook is not an OAuth connection, so a trigger anchored to one is
// tagged with this provider constant (mirrors 'zoom' on connection-anchored rows).
const PAGE_WEBHOOK_PROVIDER = 'page-webhook';

// A page webhook fans out to at most this many workflow bindings. The list
// endpoint returns the full set in one bounded query, so the create path caps
// at the same number — this keeps GET from ever silently truncating (no cursor
// needed) while staying far above any realistic wiring depth.
const MAX_TRIGGERS_PER_WEBHOOK = 100;

// Returns the webhook only if it belongs to this page — scopes every trigger op
// to a webhook the caller's page owns, and yields the page's driveId for the
// cross-drive workflow guard.
async function findWebhookWithDrive(pageId: string, webhookId: string) {
  const [webhook, page] = await Promise.all([
    db.query.pageWebhooks.findFirst({
      where: and(eq(pageWebhooks.id, webhookId), eq(pageWebhooks.pageId, pageId)),
      columns: { id: true },
    }),
    db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { driveId: true },
    }),
  ]);
  if (!webhook || !page) return null;
  return { webhookId: webhook.id, driveId: page.driveId };
}

// GET /api/pages/[pageId]/webhooks/[id]/triggers — list a webhook's workflow bindings
export async function GET(request: Request, context: { params: Promise<{ pageId: string; id: string }> }) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const { pageId, id } = await context.params;

    const canManage = await canManagePageWebhooks(auth, pageId);
    if (!canManage) {
      return NextResponse.json({ error: 'Only the drive owner or an admin can manage page webhooks' }, { status: 403 });
    }

    const scope = await findWebhookWithDrive(pageId, id);
    if (!scope) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });

    // Stable ordering so repeated reads return the same sequence, and the whole
    // set fits in one page (creation is capped at MAX_TRIGGERS_PER_WEBHOOK).
    const triggers = await db.query.webhookTriggers.findMany({
      where: eq(webhookTriggers.pageWebhookId, id),
      orderBy: [asc(webhookTriggers.createdAt), asc(webhookTriggers.id)],
      limit: MAX_TRIGGERS_PER_WEBHOOK,
    });

    return NextResponse.json({ triggers });
  } catch (error) {
    loggers.api.error('Error listing page webhook triggers', error as Error);
    return NextResponse.json({ error: 'Failed to list triggers' }, { status: 500 });
  }
}

// POST /api/pages/[pageId]/webhooks/[id]/triggers — bind a workflow to a webhook
export async function POST(request: Request, context: { params: Promise<{ pageId: string; id: string }> }) {
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
    const validation = createSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid trigger', details: validation.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { workflowId } = validation.data;

    const scope = await findWebhookWithDrive(pageId, id);
    if (!scope) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
      columns: { id: true, driveId: true },
    });
    if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

    // Cross-drive guard: a webhook must only fire workflows from its own drive —
    // binding a foreign-drive workflow would let a page in one drive drive
    // execution (and AI billing) in another.
    if (workflow.driveId !== scope.driveId) {
      return NextResponse.json(
        { error: 'Workflow must belong to the same drive as the webhook' },
        { status: 400 },
      );
    }

    // Idempotent create: re-binding an already-wired workflow is a no-op (and
    // never counts against the cap below). The partial unique on
    // (pageWebhookId, workflowId) still guards the concurrent-insert race.
    const alreadyBound = await db.query.webhookTriggers.findFirst({
      where: and(
        eq(webhookTriggers.pageWebhookId, id),
        eq(webhookTriggers.workflowId, workflowId),
      ),
    });
    if (alreadyBound) return NextResponse.json({ trigger: alreadyBound }, { status: 200 });

    // Cap genuinely-new bindings so the list endpoint's single bounded page can
    // always return the complete set.
    const [{ value: existingCount }] = await db
      .select({ value: count() })
      .from(webhookTriggers)
      .where(eq(webhookTriggers.pageWebhookId, id));
    if (existingCount >= MAX_TRIGGERS_PER_WEBHOOK) {
      return NextResponse.json(
        { error: `A webhook can have at most ${MAX_TRIGGERS_PER_WEBHOOK} workflow bindings` },
        { status: 409 },
      );
    }

    // connectionId is left NULL to satisfy the anchor XOR check.
    const [inserted] = await db
      .insert(webhookTriggers)
      .values({
        workflowId,
        pageWebhookId: id,
        provider: PAGE_WEBHOOK_PROVIDER,
        eventType: PAGE_WEBHOOK_EVENT_TYPE,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      // Lost the insert race to a concurrent identical bind — return the winner.
      const raced = await db.query.webhookTriggers.findFirst({
        where: and(
          eq(webhookTriggers.pageWebhookId, id),
          eq(webhookTriggers.workflowId, workflowId),
        ),
      });
      return NextResponse.json({ trigger: raced }, { status: 200 });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'webhook_trigger',
      resourceId: inserted.id,
      details: { operation: 'create', pageId, pageWebhookId: id, workflowId },
    });
    return NextResponse.json({ trigger: inserted }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating page webhook trigger', error as Error);
    return NextResponse.json({ error: 'Failed to create trigger' }, { status: 500 });
  }
}
