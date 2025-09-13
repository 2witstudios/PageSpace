import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, pages, drives, eq, isNull } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { PageType } from '@pagespace/lib/server';
import { getProducerQueue } from '@pagespace/lib/job-queue';

// Define allowed file types and size limits
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// Type for file metadata
interface FileMetadata {
  uploadedAt: string;
  uploadedBy: string;
  originalName: string;
  contentHash?: string;
  [key: string]: string | number | boolean | undefined;
}

// Processor service URL
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const driveId = formData.get('driveId') as string | null;
    const parentId = formData.get('parentId') as string | null;
    const title = formData.get('title') as string | null;
    const position = formData.get('position') as string | null;
    const afterNodeId = formData.get('afterNodeId') as string | null;

    // Validate required fields
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!driveId) {
      return NextResponse.json({ error: 'Drive ID is required' }, { status: 400 });
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ 
        error: `File size exceeds maximum of ${MAX_FILE_SIZE / (1024 * 1024)}MB` 
      }, { status: 400 });
    }

    // Check if mime type is allowed (with fallback for unknown types)
    const mimeType = file.type || 'application/octet-stream';
    
    // Verify drive exists and user has access
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Generate page ID
    const pageId = createId();
    
    // Sanitize filename: Replace Unicode spaces (especially U+202F from macOS screenshots) with regular spaces
    const sanitizedFileName = file.name
      .replace(/[\u202F\u00A0\u2000-\u200B\uFEFF]/g, ' ') // Replace various Unicode spaces with regular space
      .replace(/\s+/g, ' ') // Normalize multiple spaces to single space
      .trim();

    // Forward file to processor service for streaming upload and processing
    const processorFormData = new FormData();
    processorFormData.append('file', file);
    processorFormData.append('pageId', pageId);
    processorFormData.append('userId', user.id);

    try {
      const processorResponse = await fetch(`${PROCESSOR_URL}/api/upload/single`, {
        method: 'POST',
        body: processorFormData,
      });

      if (!processorResponse.ok) {
        const errorData = await processorResponse.json().catch(() => ({}));
        throw new Error(errorData.error || 'Processor upload failed');
      }

      const processorResult = await processorResponse.json();
      const { contentHash, deduplicated, size, jobs } = processorResult;

      // Calculate position for new page
      let calculatedPosition: number;
      
      if (position && position === 'before' && afterNodeId) {
        // Insert before a specific node
        const targetNode = await db.query.pages.findFirst({
          where: eq(pages.id, afterNodeId),
        });
        
        if (targetNode) {
          // Get all siblings to find the previous one
          const siblings = await db.query.pages.findMany({
            where: parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
            orderBy: (pages, { asc }) => [asc(pages.position)],
          });
          
          const targetIndex = siblings.findIndex(s => s.id === afterNodeId);
          const prevSibling = targetIndex > 0 ? siblings[targetIndex - 1] : null;
          
          // Position between previous and target
          const prevPos = prevSibling?.position || 0;
          const targetPos = targetNode.position;
          calculatedPosition = (prevPos + targetPos) / 2;
        } else {
          // Fallback to end of list
          const lastPage = await db.query.pages.findFirst({
            where: parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
            orderBy: (pages, { desc }) => [desc(pages.position)],
          });
          calculatedPosition = lastPage ? lastPage.position + 1 : 0;
        }
      } else if (position && position === 'after' && afterNodeId) {
        // Insert after a specific node
        const targetNode = await db.query.pages.findFirst({
          where: eq(pages.id, afterNodeId),
        });
        
        if (targetNode) {
          // Get the next sibling
          const siblings = await db.query.pages.findMany({
            where: parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
            orderBy: (pages, { asc }) => [asc(pages.position)],
          });
          
          const targetIndex = siblings.findIndex(s => s.id === afterNodeId);
          const nextSibling = siblings[targetIndex + 1];
          
          // Position between target and next
          const targetPos = targetNode.position;
          const nextPos = nextSibling?.position || targetPos + 2;
          calculatedPosition = (targetPos + nextPos) / 2;
        } else {
          // Fallback to end of list
          const lastPage = await db.query.pages.findFirst({
            where: parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
            orderBy: (pages, { desc }) => [desc(pages.position)],
          });
          calculatedPosition = lastPage ? lastPage.position + 1 : 0;
        }
      } else {
        // Default: add at the end
        const lastPage = await db.query.pages.findFirst({
          where: parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
          orderBy: (pages, { desc }) => [desc(pages.position)],
        });
        calculatedPosition = lastPage ? lastPage.position + 1 : 0;
      }

      // Create file metadata with content hash
      const fileMetadata: FileMetadata = {
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
        originalName: file.name, // Store original name with Unicode characters
        contentHash, // Store content hash for deduplication
      };

      // Create page entry with appropriate processing status
      const [newPage] = await db.insert(pages).values({
        id: pageId,
        title: title || sanitizedFileName, // Use sanitized name for title
        type: PageType.FILE,
        content: '', // Will be populated by background job for text files
        processingStatus: deduplicated ? 'completed' :
                         (mimeType.startsWith('image/') ? 'visual' : 'pending'),
        position: calculatedPosition,
        driveId,
        parentId: parentId || null,
        fileSize: size,
        mimeType,
        originalFileName: sanitizedFileName, // Store sanitized filename
        filePath: contentHash, // Store content hash as file identifier
        fileMetadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning();

      // If file needs any processing (text extraction, OCR, or image optimization)
      if (jobs && (jobs.textExtraction || jobs.ocr || jobs.imageOptimization)) {
        try {
          const jobQueue = await getProducerQueue();
          const priority = size < 5_000_000 ? 'high' : 'normal'; // Files under 5MB get high priority
          const jobId = await jobQueue.enqueueFileProcessing(pageId, priority);
          
          console.log(`File uploaded: ${sanitizedFileName}, Job: ${jobId}, ContentHash: ${contentHash}`);
          
          // Return 202 Accepted to indicate async processing
          return NextResponse.json(
            {
              success: true,
              page: {
                ...newPage,
                processingJobId: jobId,
                contentHash,
                deduplicated,
              },
              message: deduplicated 
                ? 'File already exists (deduplicated). Processing may be complete.'
                : 'File uploaded successfully. Processing in background.',
              processingStatus: deduplicated ? 'completed' : 'pending'
            },
            { status: 202 }
          );
        } catch (error) {
          console.error('Failed to enqueue text extraction:', error);
        }
      }

      // File uploaded and optimized successfully
      return NextResponse.json({
        success: true,
        page: {
          ...newPage,
          contentHash,
          deduplicated,
        },
        message: deduplicated 
          ? 'File already exists (deduplicated).'
          : 'File uploaded and processed successfully.',
        processingStatus: 'completed'
      });

    } catch (processorError) {
      console.error('Processor service error:', processorError);
      
      // Fallback: Still create the page entry but mark as failed
      const fileMetadata: FileMetadata = {
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
        originalName: file.name,
      };

      const [newPage] = await db.insert(pages).values({
        id: pageId,
        title: title || sanitizedFileName,
        type: PageType.FILE,
        content: '',
        processingStatus: 'failed',
        position: 0,
        driveId,
        parentId: parentId || null,
        fileSize: file.size,
        mimeType,
        originalFileName: sanitizedFileName,
        filePath: sanitizedFileName,
        fileMetadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning();

      return NextResponse.json({
        success: false,
        page: newPage,
        error: 'File upload succeeded but processing failed.',
        processingStatus: 'failed'
      }, { status: 500 });
    }

  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Failed to upload file' },
      { status: 500 }
    );
  }
}