import { NextRequest, NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';
import { getUserAccessLevel, PageType, isSheetType, parseSheetContent, serializeSheetContent, updateSheetCells, isValidCellAddress } from '@pagespace/lib/server';
import { z } from 'zod/v4';
import prettier from 'prettier';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/server';
import { authenticateMCPRequest, isAuthError } from '@/lib/auth';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';

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

// Schema for cell updates
const cellUpdateSchema = z.object({
  address: z.string(),
  value: z.string(),
});

// Schema for line/cell operations
const lineOperationSchema = z.object({
  operation: z.enum(['read', 'replace', 'insert', 'delete', 'edit-cells']),
  pageId: z.string().optional(), // Optional page ID, will use current page if not provided
  startLine: z.number().min(1).optional(),
  endLine: z.number().min(1).optional(),
  content: z.string().optional(),
  cells: z.array(cellUpdateSchema).optional(), // For edit-cells operation
});

export async function POST(req: NextRequest) {
  const auth = await authenticateMCPRequest(req);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { operation, pageId: providedPageId, startLine, endLine, content, cells } = lineOperationSchema.parse(body);
    
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
    if (operation === 'replace' || operation === 'insert' || operation === 'delete' || operation === 'edit-cells') {
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
        
        const actorInfo = await getActorInfo(userId);
        await applyPageMutation({
          pageId,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName ?? undefined,
            metadata: {
              source: 'mcp',
              mcpOperation: 'replace',
              affectedLines: `${startLine}-${actualEndLine}`,
            },
          },
        });
        
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

        const actorInfo = await getActorInfo(userId);
        await applyPageMutation({
          pageId,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName ?? undefined,
            metadata: {
              source: 'mcp',
              mcpOperation: 'insert',
              insertedAt: startLine,
              linesInserted: content.split('\n').length,
            },
          },
        });

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

        const actorInfo = await getActorInfo(userId);
        await applyPageMutation({
          pageId,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName ?? undefined,
            metadata: {
              source: 'mcp',
              mcpOperation: 'delete',
              deletedLines: `${startLine}-${actualEndLine}`,
            },
          },
        });

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

      case 'edit-cells': {
        // Validate this is a SHEET type page
        if (!isSheetType(page.type as PageType)) {
          return NextResponse.json({
            error: 'Page is not a sheet',
            message: `This page is a ${page.type}. Use edit-cells only on SHEET pages.`,
            pageType: page.type,
          }, { status: 400 });
        }

        if (!cells || cells.length === 0) {
          return NextResponse.json({ error: 'cells array is required for edit-cells operation' }, { status: 400 });
        }

        // Validate all cell addresses
        const invalidAddresses = cells.filter(cell => !isValidCellAddress(cell.address));
        if (invalidAddresses.length > 0) {
          const examples = invalidAddresses.slice(0, 3).map(c => `"${c.address}"`).join(', ');
          return NextResponse.json({
            error: `Invalid cell addresses: ${examples}. Use A1-style format (e.g., A1, B2, AA100).`,
          }, { status: 400 });
        }

        // Parse existing sheet content
        const sheetData = parseSheetContent(currentContent);

        // Apply cell updates
        const updatedSheet = updateSheetCells(sheetData, cells);

        // Serialize back to TOML format
        const newContent = serializeSheetContent(updatedSheet, { pageId });

        // Summarize changes for response and metadata
        const formulaCount = cells.filter(c => c.value.trim().startsWith('=')).length;
        const valueCount = cells.filter(c => c.value.trim() !== '' && !c.value.trim().startsWith('=')).length;
        const clearCount = cells.filter(c => c.value.trim() === '').length;

        const actorInfo = await getActorInfo(userId);
        await applyPageMutation({
          pageId,
          operation: 'update',
          updates: { content: newContent },
          updatedFields: ['content'],
          expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName,
            metadata: {
              source: 'mcp',
              mcpOperation: 'edit-cells',
              cellsUpdated: cells.length,
              valuesSet: valueCount,
              formulasSet: formulaCount,
              cellsCleared: clearCount,
            },
          },
        });

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

        return NextResponse.json({
          pageId,
          pageTitle: page.title,
          cellsUpdated: cells.length,
          operation: 'edit-cells',
          stats: {
            valuesSet: valueCount,
            formulasSet: formulaCount,
            cellsCleared: clearCount,
            sheetDimensions: {
              rows: updatedSheet.rowCount,
              columns: updatedSheet.columnCount,
            },
          },
          updatedCells: cells.map(c => ({
            address: c.address.toUpperCase(),
            type: c.value.trim() === '' ? 'cleared' : c.value.trim().startsWith('=') ? 'formula' : 'value',
          })),
        });
      }

      default:
        return NextResponse.json({ error: 'Invalid operation' }, { status: 400 });
    }
  } catch (error) {
    loggers.api.error('Error in MCP document operation:', error as Error);
    if (error instanceof PageRevisionMismatchError) {
      return NextResponse.json(
        {
          error: error.message,
          currentRevision: error.currentRevision,
          expectedRevision: error.expectedRevision,
        },
        { status: error.expectedRevision === undefined ? 428 : 409 }
      );
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to perform document operation' }, { status: 500 });
  }
}
