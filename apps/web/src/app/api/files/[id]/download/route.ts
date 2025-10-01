import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, pages, eq } from '@pagespace/db';
import { PageType, canUserViewPage, isFilePage } from '@pagespace/lib';
import { createServiceToken } from '@pagespace/lib/auth-utils';
import { sanitizeFilenameForHeader } from '@pagespace/lib/utils/file-security';

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
    // Await the params as required in Next.js 15
    const { id } = await context.params;

    // Verify authentication
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch the page/file metadata
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, id),
    });

    if (!page) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Verify it's a FILE type
    if (!isFilePage(page.type as PageType)) {
      return NextResponse.json({ error: 'Not a file' }, { status: 400 });
    }

    const canView = await canUserViewPage(user.id, page.id);
    if (!canView) {
      return NextResponse.json({ error: 'You do not have access to this file' }, { status: 403 });
    }

    if (!page.filePath) {
      return NextResponse.json({ error: 'File path not found' }, { status: 500 });
    }

    // Fetch file from processor service using content hash
    const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';
    const contentHash = page.filePath; // filePath stores the content hash

    console.log('[Download] Fetching file from processor:', {
      pageId: page.id,
      contentHash,
      processorUrl: `${PROCESSOR_URL}/cache/${contentHash}/original`,
    });

    try {
      // Create service JWT token for processor authentication
      const serviceToken = await createServiceToken('web', ['files:read'], {
        userId: user.id,
        tenantId: page.id,
        driveIds: page.driveId ? [page.driveId] : undefined,
        expirationTime: '5m'
      });

      // Request the original file from processor service
      const fileResponse = await fetch(`${PROCESSOR_URL}/cache/${contentHash}/original`, {
        headers: {
          'Authorization': `Bearer ${serviceToken}`
        },
        signal: AbortSignal.timeout(30000), // 30 second timeout for downloads
      });

      if (!fileResponse.ok) {
        throw new Error(`Processor returned ${fileResponse.status}: ${fileResponse.statusText}`);
      }

      // Get the file buffer from response
      const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
      console.log('[Download] Successfully fetched from processor, size:', fileBuffer.length);

      // Sanitize filename to prevent header injection
      const sanitizedFilename = sanitizeFilenameForHeader(page.originalFileName || page.title);

      // Set appropriate headers for file download
      const headers = new Headers();
      headers.set('Content-Type', page.mimeType || 'application/octet-stream');
      headers.set('Content-Length', page.fileSize?.toString() || fileBuffer.length.toString());
      headers.set('Content-Disposition', `attachment; filename="${sanitizedFilename}"`);
      headers.set('X-Content-Type-Options', 'nosniff'); // Prevent MIME sniffing
      headers.set('X-Frame-Options', 'DENY'); // Prevent clickjacking
      headers.set('Content-Security-Policy', "default-src 'none';"); // Extra protection

      // Return the file
      return new NextResponse(fileBuffer, {
        status: 200,
        headers,
      });
    } catch (fileError) {
      console.error('Error reading file:', fileError);
      return NextResponse.json({ error: 'File not accessible' }, { status: 500 });
    }

  } catch (error) {
    console.error('Download error:', error);
    return NextResponse.json(
      { error: 'Failed to download file' },
      { status: 500 }
    );
  }
}
