import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { isFilePage } from '@pagespace/lib/content/page-types.config';
import { PageType } from '@pagespace/lib/utils/enums';
import { isDangerousMimeType, sanitizeFilenameForHeader } from '@pagespace/lib/utils/file-security';
import { generatePresignedUrl, getPresignedUrlTtl } from '@/lib/presigned-url';
import { verifyCanvasFileViewToken } from '@/lib/canvas/file-view-token';
import { verifyAuth } from '@/lib/auth/auth';

interface RouteParams {
  params: Promise<{
    driveId: string;
    pageId: string;
  }>;
}

/** Extract a bare SHA-256 hash from legacy storagePath values like 'files/{hash}/original'. */
function toContentHash(storagePath: string): string | null {
  const m = storagePath.match(/^files\/([a-f0-9]{64})\/original$/i);
  if (m) return m[1].toLowerCase();
  return /^[a-f0-9]{64}$/i.test(storagePath) ? storagePath.toLowerCase() : null;
}

export async function GET(request: Request, context: RouteParams) {
  const { driveId, pageId } = await context.params;
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');

  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: {
      id: true,
      driveId: true,
      type: true,
      filePath: true,
      mimeType: true,
      originalFileName: true,
      title: true,
    },
  });

  if (!page || page.driveId !== driveId || !isFilePage(page.type as PageType)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const hasValidToken = verifyCanvasFileViewToken({ token, driveId, pageId });
  if (!hasValidToken) {
    const user = await verifyAuth(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const canView = await canUserViewPage(user.id, pageId);
    if (!canView) {
      return NextResponse.json({ error: 'You do not have access to this file' }, { status: 403 });
    }
  }

  if (!page.filePath) {
    return NextResponse.json({ error: 'File path not found' }, { status: 500 });
  }

  const contentHash = toContentHash(page.filePath);
  if (!contentHash) {
    return NextResponse.json({ error: 'Invalid file path' }, { status: 500 });
  }
  const mimeType = page.mimeType || 'application/octet-stream';
  const ttl = getPresignedUrlTtl(mimeType);
  const filename = sanitizeFilenameForHeader(page.originalFileName || page.title || contentHash);
  const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_');
  const disposition = isDangerousMimeType(mimeType)
    ? `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    : undefined;
  const presignedUrl = await generatePresignedUrl(contentHash, 'original', ttl, disposition, mimeType);

  return NextResponse.redirect(presignedUrl, 307);
}
