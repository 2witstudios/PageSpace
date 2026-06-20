import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { isFilePage } from '@pagespace/lib/content/page-types.config';
import { PageType } from '@pagespace/lib/utils/enums';

interface RouteParams {
  params: Promise<{
    driveId: string;
    pageId: string;
  }>;
}

export async function GET(request: Request, context: RouteParams) {
  const { driveId, pageId } = await context.params;
  const user = await verifyAuth(request);

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { id: true, driveId: true, type: true },
  });

  if (!page || page.driveId !== driveId || !isFilePage(page.type as PageType)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const canView = await canUserViewPage(user.id, pageId);
  if (!canView) {
    return NextResponse.json({ error: 'You do not have access to this file' }, { status: 403 });
  }

  return NextResponse.redirect(new URL(`/api/files/${pageId}/view`, request.url), 307);
}
