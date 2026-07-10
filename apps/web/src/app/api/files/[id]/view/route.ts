import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { files } from '@pagespace/db/schema/storage';
import { PageType } from '@pagespace/lib/utils/enums'
import { canUserViewPage } from '@pagespace/lib/permissions/permissions'
import { isFilePage } from '@pagespace/lib/content/page-types.config'
import { canUserAccessFile } from '@pagespace/lib/permissions/file-access';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isDangerousMimeType, sanitizeFilenameForHeader } from '@pagespace/lib/utils/file-security';
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
    const wantsJson = request.headers.get('Accept')?.includes('application/json') ?? false;

    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'file', resourceId: id });

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
      const ttl = getPresignedUrlTtl(mimeType);
      const filename = sanitizeFilenameForHeader(page.originalFileName || page.title || contentHash);
      const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_');
      const disposition = isDangerousMimeType(mimeType)
        ? `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
        : undefined;
      const presignedUrl = await generatePresignedUrl(contentHash, 'original', ttl, disposition, mimeType);

      auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'file', resourceId: page.id, details: { source: 'view', mimeType } });

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
    const ttl = getPresignedUrlTtl(mimeType);
    const filename = sanitizeFilenameForHeader(contentHash);
    const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_');
    const disposition = isDangerousMimeType(mimeType)
      ? `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      : undefined;
    const presignedUrl = await generatePresignedUrl(contentHash, 'original', ttl, disposition, mimeType);

    auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'file', resourceId: file.id, details: { source: 'view', mimeType } });

    if (wantsJson) return NextResponse.json({ url: presignedUrl });
    return NextResponse.redirect(presignedUrl, 307);

  } catch (error) {
    console.error('View error:', error);
    return NextResponse.json(
      { error: 'Failed to view file' },
      { status: 500 }
    );
  }
}
