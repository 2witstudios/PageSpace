import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, pages, eq } from '@pagespace/db';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PageType } from '@pagespace/lib';

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
    if (page.type !== PageType.FILE) {
      return NextResponse.json({ error: 'Not a file' }, { status: 400 });
    }

    // TODO: Check user permissions for the file
    // For now, we'll assume if they're authenticated they have access

    if (!page.filePath) {
      return NextResponse.json({ error: 'File path not found' }, { status: 500 });
    }

    // Use environment variable for storage path, fallback to /tmp for local dev
    const STORAGE_ROOT = process.env.FILE_STORAGE_PATH || '/tmp/pagespace-files';
    
    // Normalize the file path to handle Unicode characters properly
    // Replace any narrow no-break spaces (U+202F) and other problematic Unicode spaces with regular spaces
    const normalizedFilePath = page.filePath
      .replace(/[\u202F\u00A0\u2000-\u200B\uFEFF]/g, ' ') // Replace various Unicode spaces
      .replace(/\s+/g, ' ') // Normalize multiple spaces to single space
      .trim();
    
    // Construct full file path
    const fullPath = join(STORAGE_ROOT, normalizedFilePath);
    
    console.log('Attempting to read file:', {
      pageId: page.id,
      originalFilePath: page.filePath,
      normalizedFilePath,
      fullPath,
      filePathBytes: Buffer.from(page.filePath).toJSON().data,
    });

    try {
      // Try to read the file with the normalized path first
      let fileBuffer: Buffer;
      let actualPath = fullPath;
      
      try {
        fileBuffer = await readFile(fullPath);
      } catch (firstError) {
        // If the file doesn't exist with normalized path, try the original path
        // This handles existing files that were saved with Unicode characters
        const originalFullPath = join(STORAGE_ROOT, page.filePath);
        console.log('First attempt failed, trying original path:', originalFullPath);
        
        try {
          fileBuffer = await readFile(originalFullPath);
          actualPath = originalFullPath;
        } catch (secondError) {
          // If both attempts fail, throw the original error
          throw firstError;
        }
      }

      console.log('Successfully read file from:', actualPath);

      // Set appropriate headers for inline viewing
      const headers = new Headers();
      headers.set('Content-Type', page.mimeType || 'application/octet-stream');
      headers.set('Content-Length', page.fileSize?.toString() || fileBuffer.length.toString());
      // Use inline disposition for viewing in browser
      headers.set('Content-Disposition', `inline; filename="${page.originalFileName || page.title}"`);

      // Return the file
      return new NextResponse(fileBuffer, {
        status: 200,
        headers,
      });
    } catch (fileError) {
      console.error('Error reading file:', {
        error: fileError,
        pageId: page.id,
        filePath: page.filePath,
        normalizedPath: normalizedFilePath,
        fullPath,
        errorMessage: fileError instanceof Error ? fileError.message : 'Unknown error',
      });
      return NextResponse.json({ 
        error: 'File not accessible',
        details: fileError instanceof Error ? fileError.message : 'Unknown error'
      }, { status: 500 });
    }

  } catch (error) {
    console.error('View error:', error);
    return NextResponse.json(
      { error: 'Failed to view file' },
      { status: 500 }
    );
  }
}