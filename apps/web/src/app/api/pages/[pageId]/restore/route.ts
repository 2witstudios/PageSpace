import { NextResponse } from 'next/server';
import { pages, db, and, eq } from '@pagespace/db';
import { loggers, getActorInfo, auditRequest } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError, isMCPAuthResult, checkMCPPageScope } from '@/lib/auth';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import { createChangeGroupId, inferChangeGroupType, type DeferredWorkflowTrigger } from '@pagespace/lib/monitoring';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

async function recursivelyRestore(
  pageId: string,
  tx: typeof db,
  context: { userId: string; actorEmail: string; actorDisplayName?: string; changeGroupId: string; changeGroupType: 'user' | 'ai' | 'automation' | 'system'; metadata?: Record<string, unknown> }
): Promise<DeferredWorkflowTrigger[]> {
  const triggers: DeferredWorkflowTrigger[] = [];

  const [pageRecord] = await tx
    .select({ revision: pages.revision })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  if (!pageRecord) {
    return triggers;
  }

  const restoreResult = await applyPageMutation({
    pageId,
    operation: 'restore',
    updates: { isTrashed: false, trashedAt: null },
    updatedFields: ['isTrashed', 'trashedAt'],
    expectedRevision: pageRecord.revision,
    context,
    tx,
  });
  if (restoreResult.deferredTrigger) triggers.push(restoreResult.deferredTrigger);

  const children = await tx
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.parentId, pageId), eq(pages.isTrashed, true)));

  for (const child of children) {
    const childTriggers = await recursivelyRestore(child.id, tx, context);
    triggers.push(...childTriggers);
  }

  const orphanedChildren = await tx
    .select({ id: pages.id, revision: pages.revision })
    .from(pages)
    .where(eq(pages.originalParentId, pageId));

  for (const child of orphanedChildren) {
    const moveResult = await applyPageMutation({
      pageId: child.id,
      operation: 'move',
      updates: { parentId: pageId, originalParentId: null },
      updatedFields: ['parentId', 'originalParentId'],
      expectedRevision: child.revision,
      context,
      tx,
    });
    if (moveResult.deferredTrigger) triggers.push(moveResult.deferredTrigger);
  }

  return triggers;
}

export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    // Check MCP token scope before page access
    const scopeError = await checkMCPPageScope(auth, pageId);
    if (scopeError) return scopeError;

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: {
        drive: {
          columns: { id: true },
        },
      },
    });

    if (!page || !page.isTrashed) {
      return NextResponse.json({ error: 'Page is not in trash' }, { status: 400 });
    }

    const actorInfo = await getActorInfo(auth.userId);
    const changeGroupId = createChangeGroupId();
    const changeGroupType = inferChangeGroupType({ isAiGenerated: false });
    const isMCP = isMCPAuthResult(auth);

    let deferredTriggers: DeferredWorkflowTrigger[] = [];
    await db.transaction(async (tx) => {
      deferredTriggers = await recursivelyRestore(pageId, tx, {
        userId: auth.userId,
        actorEmail: actorInfo.actorEmail,
        actorDisplayName: actorInfo.actorDisplayName ?? undefined,
        changeGroupId,
        changeGroupType,
        metadata: isMCP ? { source: 'mcp' } : undefined,
      });
    });
    for (const t of deferredTriggers) t();

    if (page.drive?.id) {
      await broadcastPageEvent(
        createPageEventPayload(page.drive.id, pageId, 'restored', {
          title: page.title,
          parentId: page.parentId,
          type: page.type,
        }),
      );
    }

    trackPageOperation(auth.userId, 'restore', pageId, {
      pageTitle: page.title,
      pageType: page.type,
    });

    auditRequest(req, { eventType: 'data.write', userId: auth.userId, resourceType: 'page', resourceId: pageId, details: { operation: 'restore' } });

    return NextResponse.json({ message: 'Page restored successfully.' });
  } catch (error) {
    loggers.api.error('Error restoring page:', error as Error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to restore page';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
