import { NextResponse } from 'next/server';
import { pages, favorites, pageTags, pagePermissions, chatMessages, channelMessages, db, eq } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserDeletePage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

// Note: taskItems linked to this page are automatically deleted via FK cascade (onDelete: 'cascade')
async function recursivelyDelete(pageId: string, tx: typeof db) {
    const children = await tx.select({ id: pages.id }).from(pages).where(eq(pages.parentId, pageId));

    for (const child of children) {
        await recursivelyDelete(child.id, tx);
    }

    await tx.delete(pagePermissions).where(eq(pagePermissions.pageId, pageId));
    await tx.delete(favorites).where(eq(favorites.pageId, pageId));
    await tx.delete(pageTags).where(eq(pageTags.pageId, pageId));
    await tx.delete(chatMessages).where(eq(chatMessages.pageId, pageId));
    await tx.delete(channelMessages).where(eq(channelMessages.pageId, pageId));

    await tx.delete(pages).where(eq(pages.id, pageId));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const canDelete = await canUserDeletePage(userId, pageId);
  if (!canDelete) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    const page = await db.query.pages.findFirst({ where: eq(pages.id, pageId) });
    if (!page || !page.isTrashed) {
      return NextResponse.json({ error: 'Page is not in trash' }, { status: 400 });
    }

    // Capture page info before deletion for audit trail
    const pageTitle = page.title;
    const driveId = page.driveId;

    await db.transaction(async (tx) => {
      await recursivelyDelete(pageId, tx);
    });

    // Log permanent deletion for compliance (fire-and-forget)
    const actorInfo = await getActorInfo(userId);
    logPageActivity(userId, 'delete', {
      id: pageId,
      title: pageTitle,
      driveId,
    }, actorInfo);

    return NextResponse.json({ message: 'Page permanently deleted.' });
  } catch (error) {
    loggers.api.error('Error permanently deleting page:', error as Error);
    return NextResponse.json({ error: 'Failed to permanently delete page' }, { status: 500 });
  }
}