import { NextResponse } from 'next/server';
import { z } from "zod/v4";
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, agentAwarenessCache, pageTreeCache } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, isMCPAuthResult } from '@/lib/auth';
import { jsonResponse } from '@pagespace/lib/api-utils';
import { pageService } from '@/services/api';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) {
    return auth.error;
  }

  // Check MCP token scope before page access
  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  try {
    const result = await pageService.getPage(pageId, userId);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return jsonResponse(result.page);
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
  expectedRevision: z.number().int().min(0).optional(),
  changeGroupId: z.string().optional(), // Groups related edits in activity log
});

export async function PATCH(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  // Check MCP token scope before page access
  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  try {
    const body = await req.json();
    const safeBody = patchSchema.parse(body);
    const { expectedRevision, changeGroupId, ...updates } = safeBody;

    const isMCP = isMCPAuthResult(auth);
    const mcpMeta = isMCP ? { source: 'mcp' as const } : undefined;
    const context = changeGroupId || mcpMeta
      ? { changeGroupId, metadata: mcpMeta }
      : undefined;

    const result = await pageService.updatePage(pageId, userId, updates, {
      expectedRevision,
      context,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          error: result.error,
          currentRevision: result.currentRevision,
          expectedRevision: result.expectedRevision,
        },
        { status: result.status }
      );
    }

    // Side effects: broadcast and cache invalidation
    const driveId = result.driveId;
    const socketId = req.headers.get('X-Socket-ID') || undefined;

    // Broadcast title update (affects tree structure)
    if (safeBody.title) {
      await broadcastPageEvent(
        createPageEventPayload(driveId, pageId, 'updated', {
          title: safeBody.title,
          parentId: result.page.parentId ?? undefined,
          socketId
        })
      );

      // Invalidate agent awareness cache when an AI_CHAT page's title changes
      if (result.isAIChatPage) {
        agentAwarenessCache.invalidateDriveAgents(driveId).catch(() => {});
      }
    }

    // Broadcast content update (for document synchronization)
    if (safeBody.content) {
      await broadcastPageEvent(
        createPageEventPayload(driveId, pageId, 'content-updated', {
          title: result.page.title ?? undefined,
          parentId: result.page.parentId ?? undefined,
          socketId
        })
      );
    }

    // Invalidate page tree cache when structure changes (title or parent)
    if (safeBody.title || safeBody.parentId !== undefined) {
      pageTreeCache.invalidateDriveTree(driveId).catch(() => {});
    }

    // Track page update
    trackPageOperation(userId, 'update', pageId, {
      updatedFields: result.updatedFields,
      hasContentUpdate: !!safeBody.content,
      hasTitleUpdate: !!safeBody.title
    });

    return jsonResponse(result.page);
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
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  // Check MCP token scope before page access
  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  try {
    // Safely parse JSON body - handle empty or malformed bodies
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      // Empty or invalid JSON body - use null which schema allows
      body = null;
    }
    const parsedBody = deleteSchema.parse(body);
    const trashChildren = parsedBody?.trash_children ?? false;

    const isMCPAuth = isMCPAuthResult(auth);
    const result = await pageService.trashPage(pageId, userId, {
      trashChildren,
      metadata: isMCPAuth ? { source: 'mcp' } : undefined,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Side effects: broadcast and cache invalidation
    await broadcastPageEvent(
      createPageEventPayload(result.driveId, pageId, 'trashed', {
        title: result.pageTitle ?? undefined,
        parentId: result.parentId ?? undefined
      })
    );

    // Invalidate agent awareness cache when an AI_CHAT page is trashed
    if (result.isAIChatPage) {
      agentAwarenessCache.invalidateDriveAgents(result.driveId).catch(() => {});
    }

    // Invalidate page tree cache when structure changes
    pageTreeCache.invalidateDriveTree(result.driveId).catch(() => {});

    // Track page deletion/trash
    trackPageOperation(userId, 'trash', pageId, {
      trashChildren: trashChildren,
      pageTitle: result.pageTitle,
      pageType: result.pageType
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
