import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { isFilePage } from '@pagespace/lib/content/page-types.config';
import { PageType } from '@pagespace/lib/utils/enums';
import { generatePresignedUrl } from '@/lib/presigned-url';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  try {
    const { id } = await context.params;

    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const page = await db.query.pages.findFirst({ where: eq(pages.id, id) });

    if (!page || !isFilePage(page.type as PageType) || !page.mimeType?.startsWith('video/')) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const canView = await canUserViewPage(user.id, page.id);
    if (!canView) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const meta = page.extractionMetadata as { thumbnailKey?: string } | null;
    const thumbnailKey = meta?.thumbnailKey;

    if (!thumbnailKey) {
      return NextResponse.json({ error: 'Thumbnail not ready' }, { status: 404 });
    }

    // thumbnailKey is "cache/{hash}/thumbnail.webp" — split into hash + preset
    const match = thumbnailKey.match(/^cache\/([a-f0-9]+)\/(.+)$/i);
    if (!match) {
      return NextResponse.json({ error: 'Invalid thumbnail key' }, { status: 500 });
    }

    const [, contentHash, preset] = match;
    const presignedUrl = await generatePresignedUrl(contentHash, preset, 3600);

    auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'file', resourceId: page.id, details: { source: 'thumbnail', mimeType: page.mimeType } });

    return NextResponse.redirect(presignedUrl, 307);
  } catch (error) {
    console.error('Thumbnail error:', error);
    return NextResponse.json({ error: 'Failed to load thumbnail' }, { status: 500 });
  }
}
