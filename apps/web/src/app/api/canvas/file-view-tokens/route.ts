import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { isFilePage } from '@pagespace/lib/content/page-types.config';
import { PageType } from '@pagespace/lib/utils/enums';
import { createCanvasFileViewToken } from '@/lib/canvas/file-view-token';
import { safeParseBody } from '@/lib/validation/parse-body';

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);

const bodySchema = z.object({
  refs: z.array(z.object({
    driveId: idSchema,
    pageId: idSchema,
  })).max(100),
});

const refKey = (driveId: string, pageId: string): string => `${driveId}:${pageId}`;

export async function POST(request: Request) {
  const user = await verifyAuth(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = await safeParseBody(request, bodySchema);
  if (!parsed.success) return parsed.response;

  const uniqueRefs = Array.from(
    new Map(parsed.data.refs.map((ref) => [refKey(ref.driveId, ref.pageId), ref])).values(),
  );
  if (uniqueRefs.length === 0) {
    return NextResponse.json({ links: [] });
  }

  const rows = await db.query.pages.findMany({
    where: inArray(pages.id, uniqueRefs.map(({ pageId }) => pageId)),
    columns: { id: true, driveId: true, type: true },
  });
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  const links = (await Promise.all(uniqueRefs.map(async ({ driveId, pageId }) => {
    const row = rowsById.get(pageId);
    if (!row || row.driveId !== driveId || !isFilePage(row.type as PageType)) return null;
    if (!(await canUserViewPage(user.id, pageId))) return null;

    const token = createCanvasFileViewToken({ driveId, pageId });
    return {
      driveId,
      pageId,
      url: `/dashboard/${driveId}/${pageId}/view?token=${encodeURIComponent(token)}`,
    };
  }))).filter((link): link is { driveId: string; pageId: string; url: string } => link !== null);

  return NextResponse.json({ links });
}

