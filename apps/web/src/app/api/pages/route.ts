import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers, agentAwarenessCache, pageTreeCache, getActorInfo } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { logPageActivity } from '@pagespace/lib';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { pageService } from '@/services/api';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

// Zod schema for page creation request
const createPageSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  type: z.enum(['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'SHEET']),
  driveId: z.string().min(1, 'Drive ID is required'),
  parentId: z.string().nullable().optional(),
  content: z.string().optional(),
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

    const result = await pageService.createPage(userId, {
      title: validatedData.title,
      type: validatedData.type,
      driveId: validatedData.driveId,
      parentId: validatedData.parentId,
      content: validatedData.content,
      systemPrompt: validatedData.systemPrompt,
      enabledTools: validatedData.enabledTools,
      aiProvider: validatedData.aiProvider,
      aiModel: validatedData.aiModel,
    });

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
      await agentAwarenessCache.invalidateDriveAgents(result.driveId);
    }

    // Invalidate page tree cache when structure changes
    await pageTreeCache.invalidateDriveTree(result.driveId);

    // Track page creation using result values
    trackPageOperation(userId, 'create', result.page.id, {
      title: result.page.title,
      type: result.page.type,
      driveId: result.driveId,
      parentId: result.page.parentId,
    });

    // Log to activity audit trail with actor info
    const actorInfo = await getActorInfo(userId);
    logPageActivity(userId, 'create', {
      id: result.page.id,
      title: result.page.title ?? undefined,
      driveId: result.driveId,
    }, actorInfo);

    return NextResponse.json(result.page, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating page:', error as Error);
    return NextResponse.json({ error: 'Failed to create page' }, { status: 500 });
  }
}
