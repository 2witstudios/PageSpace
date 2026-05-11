import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { files } from '@pagespace/db/schema/storage';
import { PageType } from '@pagespace/lib/utils/enums'
import { canUserViewPage } from '@pagespace/lib/permissions/permissions'
import { isFilePage } from '@pagespace/lib/content/page-types.config'
import { canUserAccessFile } from '@pagespace/lib/permissions/file-access';
import { sanitizeFilenameForHeader } from '@pagespace/lib/utils/file-security';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { generatePresignedUrl, getPresignedUrlTtl } from '@/lib/presigned-url';

interface RouteParams {
  params: Promise<{
    id: string;
  }>;
}

export async function GET(
  request: NextRequest,
  context: RouteParams
) {
  try {
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    const filenameParam = searchParams.get('filename');

    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'file', resourceId: id, details: { action: 'download' } });

    // Try file-type page first
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, id),
    });

    if (page && isFilePage(page.type as PageType)) {
      const canView = await canUserViewPage(user.id, page.id);
      if (!canView) {
        return NextResponse.json({ error: 'You do not have access to this file' }, { status: 403 });
      }

      if (!page.filePath) {
        return NextResponse.json({ error: 'File path not found' }, { status: 500 });
      }

      const contentHash = page.filePath;
      const mimeType = page.mimeType || 'application/octet-stream';
      const filename = sanitizeFilenameForHeader(page.originalFileName || page.title);
      const disposition = `attachment; filename="${filename}"`;
      const ttl = getPresignedUrlTtl(mimeType);
      const presignedUrl = await generatePresignedUrl(contentHash, 'original', ttl, disposition);

      auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'file', resourceId: page.id, details: { source: 'download', mimeType } });

      return NextResponse.redirect(presignedUrl, 302);
    }

    // Fall back to files table (channel/DM attachments)
    const file = await db.query.files.findFirst({
      where: eq(files.id, id),
    });

    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const hasAccess = await canUserAccessFile(user.id, file.id, file.driveId);
    if (!hasAccess) {
      return NextResponse.json({ error: 'You do not have access to this file' }, { status: 403 });
    }

    const contentHash = file.storagePath || file.id;
    const mimeType = file.mimeType || 'application/octet-stream';
    const filename = sanitizeFilenameForHeader(filenameParam || contentHash);
    const disposition = `attachment; filename="${filename}"`;
    const ttl = getPresignedUrlTtl(mimeType);
    const presignedUrl = await generatePresignedUrl(contentHash, 'original', ttl, disposition);

    auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'file', resourceId: file.id, details: { source: 'download', mimeType } });

    return NextResponse.redirect(presignedUrl, 302);

  } catch (error) {
    console.error('Download error:', error);
    return NextResponse.json(
      { error: 'Failed to download file' },
      { status: 500 }
    );
  }
}
