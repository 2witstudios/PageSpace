import { NextResponse } from 'next/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, agentAwarenessCache, pageTreeCache } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { pageService } from '@/services/api';
import type { PageType } from '@/services/api';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
    const body = await request.json();
    const {
      title,
      type,
      parentId,
      driveId,
      content,
      systemPrompt,
      enabledTools,
      aiProvider,
      aiModel,
    } = body;

    const result = await pageService.createPage(userId, {
      title,
      type: type as PageType,
      driveId,
      parentId,
      content,
      systemPrompt,
      enabledTools,
      aiProvider,
      aiModel,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Side effects: broadcast and cache invalidation
    await broadcastPageEvent(
      createPageEventPayload(driveId, result.page.id, 'created', {
        parentId,
        title,
        type,
      }),
    );

    // Invalidate agent awareness cache when an AI_CHAT page is created
    if (result.isAIChatPage) {
      await agentAwarenessCache.invalidateDriveAgents(driveId);
    }

    // Invalidate page tree cache when structure changes
    await pageTreeCache.invalidateDriveTree(driveId);

    // Track page creation
    trackPageOperation(userId, 'create', result.page.id, {
      title,
      type,
      driveId,
      parentId,
    });

    return NextResponse.json(result.page, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating page:', error as Error);
    return NextResponse.json({ error: 'Failed to create page' }, { status: 500 });
  }
}
