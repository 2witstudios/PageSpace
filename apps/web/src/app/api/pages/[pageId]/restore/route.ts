import { NextResponse } from 'next/server';
import { pages, db, and, eq } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

async function recursivelyRestore(pageId: string, tx: typeof db) {
  await tx.update(pages).set({ isTrashed: false, trashedAt: null }).where(eq(pages.id, pageId));

  const children = await tx
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.parentId, pageId), eq(pages.isTrashed, true)));

  for (const child of children) {
    await recursivelyRestore(child.id, tx);
  }

  const orphanedChildren = await tx
    .select({ id: pages.id })
    .from(pages)
    .where(eq(pages.originalParentId, pageId));

  for (const child of orphanedChildren) {
    await tx
      .update(pages)
      .set({ parentId: pageId, originalParentId: null })
      .where(eq(pages.id, child.id));
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

    await db.transaction(async (tx) => {
      await recursivelyRestore(pageId, tx);
    });

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

    return NextResponse.json({ message: 'Page restored successfully.' });
  } catch (error) {
    loggers.api.error('Error restoring page:', error as Error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to restore page';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
