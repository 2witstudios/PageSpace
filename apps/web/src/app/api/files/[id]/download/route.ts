import { NextRequest, NextResponse } from 'next/server';
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
import { verifyAuth } from '@/lib/auth/auth';

/** Extract a bare SHA-256 hash from legacy storagePath values like 'files/{hash}/original'. */
function toContentHash(storagePath: string): string {
  const m = storagePath.match(/^files\/([a-f0-9]{64})\/original$/i);
  return m ? m[1].toLowerCase() : storagePath;
}

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
    // JSON mode lets the client fetch the presigned URL without credentials.
    // A credentialed fetch following the 307 into Tigris fails CORS (the
    // bucket never sends Access-Control-Allow-Credentials).
    const wantsJson = request.headers.get('Accept')?.includes('application/json') ?? false;

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

      const contentHash = toContentHash(page.filePath);
      const mimeType = page.mimeType || 'application/octet-stream';
      const filename = sanitizeFilenameForHeader(page.originalFileName || page.title);
      const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_');
      const disposition = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
      const ttl = getPresignedUrlTtl(mimeType);
      const presignedUrl = await generatePresignedUrl(contentHash, 'original', ttl, disposition);

      auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'file', resourceId: page.id, details: { source: 'download', mimeType } });

      if (wantsJson) return NextResponse.json({ url: presignedUrl });
      return NextResponse.redirect(presignedUrl, 307);
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

    const contentHash = toContentHash(file.storagePath || file.id);
    const mimeType = file.mimeType || 'application/octet-stream';
    const filename = sanitizeFilenameForHeader(filenameParam || contentHash);
    const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_');
    const disposition = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    const ttl = getPresignedUrlTtl(mimeType);
    const presignedUrl = await generatePresignedUrl(contentHash, 'original', ttl, disposition);

    auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'file', resourceId: file.id, details: { source: 'download', mimeType } });

    if (wantsJson) return NextResponse.json({ url: presignedUrl });
    return NextResponse.redirect(presignedUrl, 307);

  } catch (error) {
    console.error('Download error:', error);
    return NextResponse.json(
      { error: 'Failed to download file' },
      { status: 500 }
    );
  }
}
