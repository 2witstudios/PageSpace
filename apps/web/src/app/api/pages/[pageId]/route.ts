import { NextResponse } from 'next/server';
import { pages, mentions, chatMessages, drives, db, and, eq, inArray } from '@pagespace/db';
import { canUserViewPage, canUserEditPage, canUserDeletePage, agentAwarenessCache, pageTreeCache } from '@pagespace/lib/server';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';
import { z } from "zod/v4";
import * as cheerio from 'cheerio';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket/socket-utils';
import { loggers } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { jsonResponse } from '@pagespace/lib/api-utils';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

// Content sanitization utility
function sanitizeEmptyContent(content: string): string {
  if (!content || content.trim() === '') {
    return '';
  }
  
  // Check if content is the default empty TipTap document structure
  const trimmedContent = content.trim();
  
  // HTML format: <p></p> or <p><br></p> or similar empty paragraph variations
  const emptyParagraphPatterns = [
    /^<p><\/p>$/,
    /^<p><br><\/p>$/,
    /^<p>\s*<\/p>$/,
    /^<p><br\s*\/><\/p>$/
  ];
  
  for (const pattern of emptyParagraphPatterns) {
    if (pattern.test(trimmedContent)) {
      return '';
    }
  }
  
  // JSON format: {"type":"doc","content":[{"type":"paragraph"}]} or similar
  try {
    const parsed = JSON.parse(trimmedContent);
    if (parsed.type === 'doc' && 
        Array.isArray(parsed.content) && 
        parsed.content.length === 1 &&
        parsed.content[0].type === 'paragraph' &&
        (!parsed.content[0].content || parsed.content[0].content.length === 0)) {
      return '';
    }
  } catch {
    // Not JSON, continue with HTML checks
  }
  
  return content;
}

type DatabaseType = typeof db;
type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Helper to get drive id from page ID
async function getDriveIdFromPageId(pageId: string): Promise<string | null> {
  const result = await db.select({ id: drives.id })
    .from(pages)
    .leftJoin(drives, eq(pages.driveId, drives.id))
    .where(eq(pages.id, pageId))
    .limit(1);
  
  return result[0]?.id || null;
}

function findMentionNodes(content: unknown): string[] {
  const ids: string[] = [];
  const contentStr = Array.isArray(content) ? content.join('\n') : String(content);
  
  try {
    // Parse HTML content with cheerio
    const $ = cheerio.load(contentStr);
    
    // Find all <a> tags with data-page-id attribute
    $('a[data-page-id]').each((_, element) => {
      const pageId = $(element).attr('data-page-id');
      if (pageId) {
        ids.push(pageId);
      }
    });
    
  } catch (error) {
    loggers.api.error('Error parsing HTML content for mentions:', error as Error);
    // Fallback to original regex method for backward compatibility
    const regex = /@\[.*?\]\((.*?)\)/g;
    let match;
    while ((match = regex.exec(contentStr)) !== null) {
      ids.push(match[1]);
    }
  }
  
  return ids;
}

// Helper function to sync mentions
async function syncMentions(sourcePageId: string, content: unknown, tx: TransactionType | DatabaseType) {
  const mentionedPageIds = findMentionNodes(content);

  const existingMentionsQuery = await tx.select({ targetPageId: mentions.targetPageId }).from(mentions).where(eq(mentions.sourcePageId, sourcePageId));
  const existingMentionIds = new Set(existingMentionsQuery.map(m => m.targetPageId));

  const toCreate = mentionedPageIds.filter(id => !existingMentionIds.has(id));
  const toDelete = Array.from(existingMentionIds).filter(id => !mentionedPageIds.includes(id));

  if (toCreate.length > 0) {
    await tx.insert(mentions).values(toCreate.map(targetPageId => ({
      sourcePageId,
      targetPageId,
    })));
  }

  if (toDelete.length > 0) {
    await tx.delete(mentions).where(and(
      eq(mentions.sourcePageId, sourcePageId),
      inArray(mentions.targetPageId, toDelete)
    ));
  }
}

// Helper function for recursive trashing
// Note: Tasks linked to trashed pages are NOT deleted - they remain linked
// and are filtered out in TaskListView queries. This allows restore to work.
async function recursivelyTrash(pageId: string, tx: TransactionType | DatabaseType) {
    const children = await tx.select({ id: pages.id }).from(pages).where(eq(pages.parentId, pageId));

    for (const child of children) {
        await recursivelyTrash(child.id, tx);
    }

    await tx.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(eq(pages.id, pageId));
}

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Check user permissions first
    const canView = await canUserViewPage(userId, pageId);
    if (!canView) {
      return new NextResponse("Forbidden", { status: 403 });
    }

    // Fetch the primary page object
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!page) {
      return new NextResponse("Not Found", { status: 404 });
    }

    // Fetch related data in parallel for better performance
    const [children, messages] = await Promise.all([
      db.query.pages.findMany({ 
        where: eq(pages.parentId, pageId) 
      }),
      db.query.chatMessages.findMany({ 
        where: and(eq(chatMessages.pageId, pageId), eq(chatMessages.isActive, true)),
        with: { user: true },
        orderBy: (messages, { asc }) => [asc(messages.createdAt)],
      })
    ]);

    const pageWithDetails = {
      ...page,
      content: sanitizeEmptyContent(page.content || ''),
      children,
      messages
    };

    return jsonResponse(pageWithDetails);
  } catch (error) {
    loggers.api.error('Error fetching page details:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch page details' }, { status: 500 });
  }
}

const patchSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  aiProvider: z.string().optional(),
  aiModel: z.string().optional(),
  parentId: z.string().nullable().optional(),
  isPaginated: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Check if user has edit permission
    const canEdit = await canUserEditPage(userId, pageId);
    if (!canEdit) {
      return NextResponse.json({ 
        error: 'You need edit permission to modify this page',
        details: 'Contact the page owner to request edit access'
      }, { status: 403 });
    }
    const body = await req.json();
    loggers.api.debug(`--- Updating Page ${pageId} ---`);
    loggers.api.debug('Request Body:', body);
    const safeBody = patchSchema.parse(body);
    loggers.api.debug('Validated Body:', safeBody);

    // Validate parent change to prevent circular references
    if (safeBody.parentId !== undefined) {
      const validation = await validatePageMove(pageId, safeBody.parentId);
      if (!validation.valid) {
        return NextResponse.json(
          { error: validation.error },
          { status: 400 }
        );
      }
    }

    await db.transaction(async (tx) => {
      // Sanitize content before saving to remove empty TipTap default structures
      const updatedBody = { ...safeBody };
      if (updatedBody.content) {
        const originalContent = updatedBody.content;
        updatedBody.content = sanitizeEmptyContent(updatedBody.content);
        loggers.api.debug('Content sanitized:', { 
          original: originalContent.substring(0, 100) + (originalContent.length > 100 ? '...' : ''),
          sanitized: updatedBody.content.substring(0, 100) + (updatedBody.content.length > 100 ? '...' : '')
        });
      }
      
      await tx.update(pages).set({ ...updatedBody }).where(eq(pages.id, pageId));
      loggers.api.debug('Database Update Successful');

      if (updatedBody.content) {
        await syncMentions(pageId, updatedBody.content, tx);
        loggers.api.debug('Mention Sync Successful');
      }
    });

    // Refetch the page with all details to ensure the client gets the full object
    const [updatedPage, children, messages] = await Promise.all([
      db.query.pages.findFirst({
        where: eq(pages.id, pageId),
      }),
      db.query.pages.findMany({ 
        where: eq(pages.parentId, pageId) 
      }),
      db.query.chatMessages.findMany({ 
        where: and(eq(chatMessages.pageId, pageId), eq(chatMessages.isActive, true)),
        with: { user: true },
        orderBy: (messages, { asc }) => [asc(messages.createdAt)],
      })
    ]);

    const updatedPageWithDetails = {
      ...updatedPage,
      children,
      messages
    };

    // Broadcast page update events
    const driveId = await getDriveIdFromPageId(pageId);
    if (driveId) {
      // Extract socket ID from request headers to prevent self-refetch loop
      const socketId = req.headers.get('X-Socket-ID') || undefined;

      // Broadcast title update (affects tree structure)
      if (safeBody.title) {
        await broadcastPageEvent(
          createPageEventPayload(driveId, pageId, 'updated', {
            title: safeBody.title,
            parentId: updatedPage?.parentId,
            socketId
          })
        );

        // Invalidate agent awareness cache when an AI_CHAT page's title changes
        if (updatedPage?.type === 'AI_CHAT') {
          await agentAwarenessCache.invalidateDriveAgents(driveId);
        }
      }

      // Broadcast content update (for document synchronization)
      if (safeBody.content) {
        await broadcastPageEvent(
          createPageEventPayload(driveId, pageId, 'content-updated', {
            title: updatedPage?.title,
            parentId: updatedPage?.parentId,
            socketId
          })
        );
      }

      // Invalidate page tree cache when structure changes (title or parent)
      if (safeBody.title || safeBody.parentId !== undefined) {
        await pageTreeCache.invalidateDriveTree(driveId);
      }
    }

    // Track page update
    trackPageOperation(userId, 'update', pageId, {
      updatedFields: Object.keys(safeBody),
      hasContentUpdate: !!safeBody.content,
      hasTitleUpdate: !!safeBody.title
    });

    return jsonResponse(updatedPageWithDetails);
  } catch (error) {
    loggers.api.error('Error updating page:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to update page' }, { status: 500 });
  }
}

const deleteSchema = z.object({
  trash_children: z.boolean().optional(),
}).nullable();

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Check if user has delete permission
    const canDelete = await canUserDeletePage(userId, pageId);
    if (!canDelete) {
      return NextResponse.json({ 
        error: 'You need delete permission to remove this page',
        details: 'Contact the page owner to request delete access'
      }, { status: 403 });
    }
    const body = await req.json();
    const parsedBody = deleteSchema.parse(body);
    const trashChildren = parsedBody?.trash_children ?? false;

    // Get page info and drive slug before deletion
    const pageInfo = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      with: {
        drive: {
          columns: { id: true }
        }
      }
    });

    await db.transaction(async (tx) => {
      if (trashChildren) {
        await recursivelyTrash(pageId, tx);
      } else {
        const page = await tx.query.pages.findFirst({ where: eq(pages.id, pageId) });
        await tx.update(pages).set({
          parentId: page?.parentId,
          originalParentId: pageId
        }).where(eq(pages.parentId, pageId));

        await tx.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(eq(pages.id, pageId));
      }
    });

    // Broadcast page deletion event
    if (pageInfo?.drive?.id) {
      await broadcastPageEvent(
        createPageEventPayload(pageInfo.drive.id, pageId, 'trashed', {
          title: pageInfo.title,
          parentId: pageInfo.parentId
        })
      );

      // Invalidate agent awareness cache when an AI_CHAT page is trashed
      if (pageInfo.type === 'AI_CHAT') {
        await agentAwarenessCache.invalidateDriveAgents(pageInfo.drive.id);
      }

      // Invalidate page tree cache when structure changes
      await pageTreeCache.invalidateDriveTree(pageInfo.drive.id);
    }

    // Track page deletion/trash
    trackPageOperation(userId, 'trash', pageId, {
      trashChildren: trashChildren,
      pageTitle: pageInfo?.title,
      pageType: pageInfo?.type
    });

    return NextResponse.json({ message: 'Page moved to trash successfully.' });
  } catch (error) {
    loggers.api.error('Error deleting page:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to delete page' }, { status: 500 });
  }
}
