import { NextResponse } from 'next/server';
import { pages, favorites, pageTags, pagePermissions, chatMessages, channelMessages, db, eq } from '@pagespace/db';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { loggers } from '@pagespace/lib/logger-config';

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
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const decoded = decodeToken(accessToken);
  if (!decoded) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const page = await db.query.pages.findFirst({ where: eq(pages.id, pageId) });
    if (!page || !page.isTrashed) {
      return NextResponse.json({ error: 'Page is not in trash' }, { status: 400 });
    }

    await db.transaction(async (tx) => {
      await recursivelyDelete(pageId, tx);
    });

    return NextResponse.json({ message: 'Page permanently deleted.' });
  } catch (error) {
    loggers.api.error('Error permanently deleting page:', error as Error);
    return NextResponse.json({ error: 'Failed to permanently delete page' }, { status: 500 });
  }
}