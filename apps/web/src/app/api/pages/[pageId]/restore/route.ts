import { NextResponse } from 'next/server';
import { pages, db, and, eq } from '@pagespace/db';
import { loggers, pageTreeCache, getActorInfo } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError, isMCPAuthResult } from '@/lib/auth';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import { createChangeGroupId, inferChangeGroupType } from '@pagespace/lib/monitoring';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

async function recursivelyRestore(
  pageId: string,
  tx: typeof db,
  context: { userId: string; actorEmail: string; actorDisplayName?: string; changeGroupId: string; changeGroupType: 'user' | 'ai' | 'automation' | 'system'; metadata?: Record<string, unknown> }
) {
  const [pageRecord] = await tx
    .select({ revision: pages.revision })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  if (!pageRecord) {
    return;
  }

  await applyPageMutation({
    pageId,
    operation: 'restore',
    updates: { isTrashed: false, trashedAt: null },
    updatedFields: ['isTrashed', 'trashedAt'],
    expectedRevision: pageRecord.revision,
    context,
    tx,
  });

  const children = await tx
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.parentId, pageId), eq(pages.isTrashed, true)));

  for (const child of children) {
    await recursivelyRestore(child.id, tx, context);
  }

  const orphanedChildren = await tx
    .select({ id: pages.id, revision: pages.revision })
    .from(pages)
    .where(eq(pages.originalParentId, pageId));

  for (const child of orphanedChildren) {
    await applyPageMutation({
      pageId: child.id,
      operation: 'move',
      updates: { parentId: pageId, originalParentId: null },
      updatedFields: ['parentId', 'originalParentId'],
      expectedRevision: child.revision,
      context,
      tx,
    });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
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

    await db.transaction(async (tx) => {
      await recursivelyRestore(pageId, tx, {
        userId: auth.userId,
        actorEmail: actorInfo.actorEmail,
        actorDisplayName: actorInfo.actorDisplayName ?? undefined,
        changeGroupId,
        changeGroupType,
        metadata: isMCP ? { source: 'mcp' } : undefined,
      });
    });

    if (page.drive?.id) {
      await broadcastPageEvent(
        createPageEventPayload(page.drive.id, pageId, 'restored', {
          title: page.title,
          parentId: page.parentId,
          type: page.type,
        }),
      );

      // Invalidate page tree cache when structure changes
      pageTreeCache.invalidateDriveTree(page.drive.id).catch(() => {});
    }

    trackPageOperation(auth.userId, 'restore', pageId, {
      pageTitle: page.title,
      pageType: page.type,
    });

    return NextResponse.json({ message: 'Page restored successfully.' });
  } catch (error) {
    loggers.api.error('Error restoring page:', error as Error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to restore page';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
