import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, pages, files, eq } from '@pagespace/db';
import { PageType, canUserViewPage, isFilePage, createPageServiceToken, createDriveServiceToken } from '@pagespace/lib';
import { isUserDriveMember } from '@pagespace/lib/permissions';
import { sanitizeFilenameForHeader } from '@pagespace/lib/utils/file-security';

interface RouteParams {
  params: Promise<{
    id: string;
  }>;
}

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

/**
 * Fetch a file from the processor and return it as a download
 */
async function fetchAndDownloadFile(
  contentHash: string,
  serviceToken: string,
  filename: string,
  mimeType: string,
  fileSize?: number
): Promise<NextResponse> {
  const fileResponse = await fetch(`${PROCESSOR_URL}/cache/${contentHash}/original`, {
    headers: {
      'Authorization': `Bearer ${serviceToken}`
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!fileResponse.ok) {
    throw new Error(`Processor returned ${fileResponse.status}: ${fileResponse.statusText}`);
  }

  const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
  const sanitizedFilename = sanitizeFilenameForHeader(filename);

  const headers = new Headers();
  headers.set('Content-Type', mimeType || 'application/octet-stream');
  headers.set('Content-Length', fileSize?.toString() || fileBuffer.length.toString());
  headers.set('Content-Disposition', `attachment; filename="${sanitizedFilename}"`);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "default-src 'none';");

  return new NextResponse(fileBuffer, { status: 200, headers });
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

    // First, try to find as a FILE-type page (existing behavior)
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, id),
    });

    if (page && isFilePage(page.type as PageType)) {
      // Handle FILE-type page
      const canView = await canUserViewPage(user.id, page.id);
      if (!canView) {
        return NextResponse.json({ error: 'You do not have access to this file' }, { status: 403 });
      }

      if (!page.filePath) {
        return NextResponse.json({ error: 'File path not found' }, { status: 500 });
      }

      const contentHash = page.filePath;

      try {
        const { token: serviceToken } = await createPageServiceToken(
          user.id,
          page.id,
          ['files:read'],
          '5m'
        );

        return await fetchAndDownloadFile(
          contentHash,
          serviceToken,
          page.originalFileName || page.title,
          page.mimeType || 'application/octet-stream',
          page.fileSize ?? undefined
        );
      } catch (fileError) {
        const isTimeout = fileError instanceof Error && fileError.name === 'TimeoutError';
        console.error('Error downloading file page:', {
          pageId: page.id,
          contentHash,
          isTimeout,
          error: fileError instanceof Error ? fileError.message : 'Unknown error',
        });
        return NextResponse.json({
          error: isTimeout ? 'Request timed out' : 'File not accessible'
        }, { status: isTimeout ? 504 : 500 });
      }
    }

    // If not a FILE-type page, try to find in the files table (for channel attachments)
    const file = await db.query.files.findFirst({
      where: eq(files.id, id),
    });

    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Check if user has access to the drive that owns this file (owner or member)
    const hasAccess = await isUserDriveMember(user.id, file.driveId);
    if (!hasAccess) {
      return NextResponse.json({ error: 'You do not have access to this file' }, { status: 403 });
    }

    const contentHash = file.storagePath || file.id;

    try {
      const { token: serviceToken } = await createDriveServiceToken(
        user.id,
        file.driveId,
        ['files:read'],
        '5m'
      );

      return await fetchAndDownloadFile(
        contentHash,
        serviceToken,
        filenameParam || contentHash,
        file.mimeType || 'application/octet-stream',
        file.sizeBytes
      );
    } catch (fileError) {
      const isTimeout = fileError instanceof Error && fileError.name === 'TimeoutError';
      console.error('Error downloading file:', {
        fileId: file.id,
        contentHash,
        isTimeout,
        error: fileError instanceof Error ? fileError.message : 'Unknown error',
      });
      return NextResponse.json({
        error: isTimeout ? 'Request timed out' : 'File not accessible'
      }, { status: isTimeout ? 504 : 500 });
    }

  } catch (error) {
    console.error('Download error:', error);
    return NextResponse.json(
      { error: 'Failed to download file' },
      { status: 500 }
    );
  }
}
