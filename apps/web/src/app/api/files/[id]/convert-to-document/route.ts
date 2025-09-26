import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, pages, eq } from '@pagespace/db';
import { PageType, canConvertToType, canUserEditPage, canUserViewPage } from '@pagespace/lib';
import mammoth from 'mammoth';
import { createId } from '@paralleldrive/cuid2';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';

interface RouteParams {
  params: Promise<{
    id: string;
  }>;
}

export async function POST(
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

    // Get request body
    const body = await request.json();
    const { title } = body;

    if (!title || typeof title !== 'string') {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }

    // Fetch the file metadata
    const filePage = await db.query.pages.findFirst({
      where: eq(pages.id, id),
      with: {
        drive: true,
      },
    });

    if (!filePage) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Verify conversion is allowed
    if (!canConvertToType(filePage.type as PageType, PageType.DOCUMENT)) {
      return NextResponse.json({ error: 'Cannot convert this page type to document' }, { status: 400 });
    }

    // Verify it's a Word document
    const isWordDoc = [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ].includes(filePage.mimeType || '');

    if (!isWordDoc) {
      return NextResponse.json({ error: 'File is not a Word document' }, { status: 400 });
    }

    const canView = await canUserViewPage(user.id, filePage.id);
    if (!canView) {
      return NextResponse.json({ error: 'You do not have access to this file' }, { status: 403 });
    }

    const canEdit = await canUserEditPage(user.id, filePage.id);
    if (!canEdit) {
      return NextResponse.json({ error: 'You do not have permission to convert this file' }, { status: 403 });
    }

    if (!filePage.filePath) {
      return NextResponse.json({ error: 'File path not found' }, { status: 500 });
    }

    // Fetch file from processor service using content hash
    const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';
    const contentHash = filePage.filePath; // filePath stores the content hash

    console.log('[Convert] Fetching file from processor:', {
      pageId: filePage.id,
      contentHash,
      processorUrl: `${PROCESSOR_URL}/cache/${contentHash}/original`,
    });

    // Request the original file from processor service
    const fileResponse = await fetch(`${PROCESSOR_URL}/cache/${contentHash}/original`, {
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!fileResponse.ok) {
      throw new Error(`Processor returned ${fileResponse.status}: ${fileResponse.statusText}`);
    }

    // Get the file buffer from response
    const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
    console.log('[Convert] Successfully fetched from processor, size:', fileBuffer.length);

    // Convert DOCX to HTML using mammoth
    const result = await mammoth.convertToHtml({ buffer: fileBuffer });
    
    if (result.messages && result.messages.length > 0) {
      console.warn('Conversion messages:', result.messages);
    }

    // Clean up the HTML content
    // Remove excessive whitespace and normalize line breaks
    const htmlContent = result.value
      .replace(/\n\s*\n\s*\n/g, '\n\n') // Remove excessive line breaks
      .trim();

    // Create a new DOCUMENT page with the converted content
    const newPageId = createId();
    
    // Get position for new page (place it right after the original file)
    const newPosition = filePage.position + 0.5;

    // Create the new document page
    const [newPage] = await db.insert(pages).values({
      id: newPageId,
      title: title.trim(),
      type: PageType.DOCUMENT,
      content: htmlContent,
      position: newPosition,
      driveId: filePage.driveId,
      parentId: filePage.parentId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    // Broadcast the page creation event
    if (filePage.drive) {
      await broadcastPageEvent(
        createPageEventPayload(filePage.drive.id, newPageId, 'created', {
          title: newPage.title,
          type: newPage.type,
          parentId: newPage.parentId,
        })
      );
    }

    return NextResponse.json({
      success: true,
      pageId: newPage.id,
      title: newPage.title,
    });

  } catch (error) {
    console.error('Document conversion error:', error);
    return NextResponse.json(
      { error: 'Failed to convert document' },
      { status: 500 }
    );
  }
}