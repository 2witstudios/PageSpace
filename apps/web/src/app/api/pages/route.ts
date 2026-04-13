import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, agentAwarenessCache, pageTreeCache, getCreatablePageTypes, auditRequest } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError, checkMCPCreateScope, isMCPAuthResult } from '@/lib/auth';
import { pageService, type CreatePageParams } from '@/services/api';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

// Zod schema for page creation request
const createPageSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  type: z.enum(getCreatablePageTypes() as [string, ...string[]]),
  driveId: z.string().min(1, 'Drive ID is required'),
  parentId: z.string().nullable().optional(),
  content: z.string().optional(),
  contentMode: z.enum(['html', 'markdown']).optional(),
  systemPrompt: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  aiProvider: z.string().optional(),
  aiModel: z.string().optional(),
});

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
    const body = await request.json();

    // Validate request body with Zod
    const parseResult = createPageSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues.map(i => i.message).join('. ') },
        { status: 400 }
      );
    }

    const validatedData = parseResult.data;

    // Check MCP token scope - scoped tokens can only create pages in allowed drives
    const scopeError = checkMCPCreateScope(auth, validatedData.driveId);
    if (scopeError) {
      return scopeError;
    }

    // Track MCP source so the unread indicator (blue dot) shows for MCP-created pages.
    // Without this, MCP-created pages are filtered out as "the user's own changes" since
    // MCP tokens authenticate as the owning user.
    const isMCP = isMCPAuthResult(auth);
    const createOptions = isMCP ? { context: { metadata: { source: 'mcp' } } } : undefined;

    const result = await pageService.createPage(userId, {
      title: validatedData.title,
      type: validatedData.type as CreatePageParams['type'],
      driveId: validatedData.driveId,
      parentId: validatedData.parentId,
      content: validatedData.content,
      contentMode: validatedData.contentMode,
      systemPrompt: validatedData.systemPrompt,
      enabledTools: validatedData.enabledTools,
      aiProvider: validatedData.aiProvider,
      aiModel: validatedData.aiModel,
    }, createOptions);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Side effects: use result values (normalized/canonical) instead of request body
    await broadcastPageEvent(
      createPageEventPayload(result.driveId, result.page.id, 'created', {
        parentId: result.page.parentId ?? undefined,
        title: result.page.title ?? undefined,
        type: result.page.type,
      }),
    );

    // Invalidate agent awareness cache when an AI_CHAT page is created
    if (result.isAIChatPage) {
      agentAwarenessCache.invalidateDriveAgents(result.driveId).catch(err => {
        loggers.api.warn('Agent awareness cache invalidation failed', {
          error: err instanceof Error ? err.message : String(err),
          driveId: result.driveId,
        });
      });
    }

    // Invalidate page tree cache when structure changes
    pageTreeCache.invalidateDriveTree(result.driveId).catch(err => {
      loggers.api.warn('Page tree cache invalidation failed', {
        error: err instanceof Error ? err.message : String(err),
        driveId: result.driveId,
      });
    });

    // Track page creation using result values
    trackPageOperation(userId, 'create', result.page.id, {
      title: result.page.title,
      type: result.page.type,
      driveId: result.driveId,
      parentId: result.page.parentId,
    });

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'page', resourceId: result.page.id, details: { title: result.page.title, type: result.page.type, driveId: result.driveId } });

    return NextResponse.json(result.page, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating page:', error as Error);
    return NextResponse.json({ error: 'Failed to create page' }, { status: 500 });
  }
}
