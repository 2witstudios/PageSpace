import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, pages, drives, eq, isNull } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { PageType } from '@pagespace/lib';

// Define allowed file types and size limits
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// Type for file metadata
interface FileMetadata {
  uploadedAt: string;
  uploadedBy: string;
  originalName: string;
  [key: string]: string | number | boolean;
}

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

    // TODO: Check user permissions for the drive
    // For now, we'll assume if they're authenticated they have access

    // Generate page ID and file path
    const pageId = createId();
    // Sanitize filename: Replace Unicode spaces (especially U+202F from macOS screenshots) with regular spaces
    const sanitizedFileName = file.name
      .replace(/[\u202F\u00A0\u2000-\u200B\uFEFF]/g, ' ') // Replace various Unicode spaces with regular space
      .replace(/\s+/g, ' ') // Normalize multiple spaces to single space
      .trim();
    
    // Use environment variable for storage path, fallback to /tmp for local dev
    const STORAGE_ROOT = process.env.FILE_STORAGE_PATH || '/tmp/pagespace-files';
    const storagePath = join(STORAGE_ROOT, 'files', driveId, pageId);
    const filePath = join(storagePath, sanitizedFileName);

    // Create storage directory
    await mkdir(storagePath, { recursive: true });

    // Convert file to buffer and save
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    await writeFile(filePath, buffer);

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

    // Create file metadata
    const fileMetadata: FileMetadata = {
      uploadedAt: new Date().toISOString(),
      uploadedBy: user.id,
      originalName: file.name, // Store original name with Unicode characters
    };

    // Create page entry for the file
    const newPage = await db.insert(pages).values({
      id: pageId,
      title: title || sanitizedFileName, // Use sanitized name for title
      type: PageType.FILE,
      content: '', // Files don't have text content initially
      position: calculatedPosition,
      driveId,
      parentId: parentId || null,
      fileSize: file.size,
      mimeType,
      originalFileName: sanitizedFileName, // Store sanitized filename
      filePath: join('files', driveId, pageId, sanitizedFileName), // Store relative path with sanitized name
      fileMetadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    return NextResponse.json({
      success: true,
      page: newPage[0],
    });

  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Failed to upload file' },
      { status: 500 }
    );
  }
}