import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, pages, eq } from '@pagespace/db';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PageType, isFilePage } from '@pagespace/lib';

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

    // TODO: Check user permissions for the file
    // For now, we'll assume if they're authenticated they have access

    if (!page.filePath) {
      return NextResponse.json({ error: 'File path not found' }, { status: 500 });
    }

    // Use environment variable for storage path, fallback to /tmp for local dev
    const STORAGE_ROOT = process.env.FILE_STORAGE_PATH || '/tmp/pagespace-files';
    // Construct full file path
    const fullPath = join(STORAGE_ROOT, page.filePath);

    try {
      // Read the file
      const fileBuffer = await readFile(fullPath);

      // Set appropriate headers for file download
      const headers = new Headers();
      headers.set('Content-Type', page.mimeType || 'application/octet-stream');
      headers.set('Content-Length', page.fileSize?.toString() || fileBuffer.length.toString());
      headers.set('Content-Disposition', `attachment; filename="${page.originalFileName || page.title}"`);

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