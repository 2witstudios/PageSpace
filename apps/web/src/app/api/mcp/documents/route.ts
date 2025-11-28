import { NextRequest, NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';
import { getUserAccessLevel } from '@pagespace/lib/server';
import { z } from 'zod/v4';
import prettier from 'prettier';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket/socket-utils';
import { loggers } from '@pagespace/lib/server';
import { authenticateMCPRequest, isAuthError } from '@/lib/auth';

// Get the current page ID for the user
async function getCurrentPageId(userId: string): Promise<string | null> {
  try {
    // For now, we'll get the user's most recently modified page
    // In a future iteration, we might track the "active" page differently
    const userPage = await db.query.pages.findFirst({
      where: (pages, { isNull }) => isNull(pages.isTrashed),
      with: {
        drive: true,
      },
      orderBy: (pages, { desc }) => [desc(pages.updatedAt)],
    });
    
    // Filter for pages owned by the user
    if (userPage && userPage.drive.ownerId === userId) {
      return userPage.id;
    }
    
    return null;
  } catch (error) {
    loggers.api.error('Error getting current page:', error as Error);
    return null;
  }
}

// Get drive slug from page for socket broadcasting
async function getDriveIdFromPage(pageId: string): Promise<string | null> {
  try {
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: {
        drive: true,
      },
    });
    
    return page?.drive?.id || null;
  } catch (error) {
    loggers.api.error('Error getting drive id:', error as Error);
    return null;
  }
}

// Format HTML content with Prettier
async function formatHtml(html: string): Promise<string> {
  try {
    const formatted = await prettier.format(html, {
      parser: 'html',
      printWidth: 120,
      tabWidth: 2,
      useTabs: false,
      singleQuote: false,
      bracketSpacing: true,
    });
    return formatted;
  } catch (error) {
    loggers.api.error('Prettier formatting error:', error as Error);
    return html; // Return unformatted if Prettier fails
  }
}

// Split content into lines and add line numbers
function getNumberedLines(content: string): string[] {
  const lines = content.split('\n');
  return lines.map((line, index) => `${(index + 1).toString().padStart(4, ' ')} | ${line}`);
}

// Schema for line operations
const lineOperationSchema = z.object({
  operation: z.enum(['read', 'replace', 'insert', 'delete']),
  pageId: z.string().optional(), // Optional page ID, will use current page if not provided
  startLine: z.number().min(1).optional(),
  endLine: z.number().min(1).optional(),
  content: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateMCPRequest(req);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { operation, pageId: providedPageId, startLine, endLine, content } = lineOperationSchema.parse(body);
    
    // Get the page ID (use provided or get current)
    const pageId = providedPageId || await getCurrentPageId(userId);
    
    if (!pageId) {
      return NextResponse.json({ error: 'No active document found' }, { status: 404 });
    }
    
    // Check user permissions
    const accessLevel = await getUserAccessLevel(userId, pageId);
    if (!accessLevel) {
      return new NextResponse('Forbidden', { status: 403 });
    }

    // Validate write permissions for mutating operations
    if (operation === 'replace' || operation === 'insert' || operation === 'delete') {
      if (!accessLevel.canEdit) {
        loggers.api.warn('MCP write operation denied - insufficient permissions', {
          userId,
          pageId,
          operation,
          permissions: accessLevel
        });
        return NextResponse.json(
          {
            error: 'Write permission required',
            details: `The '${operation}' operation requires edit access to this document`
          },
          { status: 403 }
        );
      }
    }

    // Fetch the page
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });
    
    if (!page) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }
    
    const currentContent = page.content || '';
    const lines = currentContent.split('\n');
    
    switch (operation) {
      case 'read': {
        const numberedLines = getNumberedLines(currentContent);
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          totalLines: lines.length,
          numberedLines,
          content: currentContent,
        });
      }
      
      case 'replace': {
        if (!startLine || !content) {
          return NextResponse.json({ error: 'startLine and content are required for replace' }, { status: 400 });
        }
        
        const actualEndLine = endLine || startLine;
        
        if (startLine > lines.length || actualEndLine > lines.length) {
          return NextResponse.json({ error: 'Line number out of range' }, { status: 400 });
        }
        
        // Replace lines (convert to 0-based index)
        const newLines = [
          ...lines.slice(0, startLine - 1),
          ...content.split('\n'),
          ...lines.slice(actualEndLine),
        ];
        
        const newContent = await formatHtml(newLines.join('\n'));
        
        // Update the page
        await db.update(pages).set({
          content: newContent,
          updatedAt: new Date(),
        }).where(eq(pages.id, pageId));
        
        // Broadcast content update event
        const driveId = await getDriveIdFromPage(pageId);
        if (driveId) {
          await broadcastPageEvent(
            createPageEventPayload(driveId, pageId, 'content-updated', {
              title: page.title,
              parentId: page.parentId
            })
          );
        }
        
        const numberedLines = getNumberedLines(newContent);
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          totalLines: newLines.length,
          numberedLines,
          operation: 'replace',
          affectedLines: `${startLine}-${actualEndLine}`,
        });
      }
      
      case 'insert': {
        if (!startLine || !content) {
          return NextResponse.json({ error: 'startLine and content are required for insert' }, { status: 400 });
        }
        
        // Insert at line (convert to 0-based index)
        const insertIndex = Math.min(startLine - 1, lines.length);
        const newLines = [
          ...lines.slice(0, insertIndex),
          ...content.split('\n'),
          ...lines.slice(insertIndex),
        ];
        
        const newContent = await formatHtml(newLines.join('\n'));
        
        // Update the page
        await db.update(pages).set({
          content: newContent,
          updatedAt: new Date(),
        }).where(eq(pages.id, pageId));
        
        // Broadcast content update event
        const driveId = await getDriveIdFromPage(pageId);
        if (driveId) {
          await broadcastPageEvent(
            createPageEventPayload(driveId, pageId, 'content-updated', {
              title: page.title,
              parentId: page.parentId
            })
          );
        }
        
        const numberedLines = getNumberedLines(newContent);
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          totalLines: newLines.length,
          numberedLines,
          operation: 'insert',
          insertedAt: startLine,
        });
      }
      
      case 'delete': {
        if (!startLine) {
          return NextResponse.json({ error: 'startLine is required for delete' }, { status: 400 });
        }
        
        const actualEndLine = endLine || startLine;
        
        if (startLine > lines.length || actualEndLine > lines.length) {
          return NextResponse.json({ error: 'Line number out of range' }, { status: 400 });
        }
        
        // Delete lines (convert to 0-based index)
        const newLines = [
          ...lines.slice(0, startLine - 1),
          ...lines.slice(actualEndLine),
        ];
        
        const newContent = await formatHtml(newLines.join('\n'));
        
        // Update the page
        await db.update(pages).set({
          content: newContent,
          updatedAt: new Date(),
        }).where(eq(pages.id, pageId));
        
        // Broadcast content update event
        const driveId = await getDriveIdFromPage(pageId);
        if (driveId) {
          await broadcastPageEvent(
            createPageEventPayload(driveId, pageId, 'content-updated', {
              title: page.title,
              parentId: page.parentId
            })
          );
        }
        
        const numberedLines = getNumberedLines(newContent);
        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          totalLines: newLines.length,
          numberedLines,
          operation: 'delete',
          deletedLines: `${startLine}-${actualEndLine}`,
        });
      }
      
      default:
        return NextResponse.json({ error: 'Invalid operation' }, { status: 400 });
    }
  } catch (error) {
    loggers.api.error('Error in MCP document operation:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to perform document operation' }, { status: 500 });
  }
}