import { NextResponse } from 'next/server';
import { db, drives, pages, users, and, eq, desc } from '@pagespace/db';
import {
  validatePageCreation,
  validateAIChatTools,
  getDefaultContent,
  PageType as PageTypeEnum,
  isAIChatPage,
} from '@pagespace/lib';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/logger-config';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
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
    } = await request.json();

    if (!title || !type || !driveId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const drive = await db.query.drives.findFirst({
      where: and(eq(drives.id, driveId), eq(drives.ownerId, userId)),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    const lastPage = await db.query.pages.findFirst({
      where: and(eq(pages.parentId, parentId), eq(pages.driveId, drive.id)),
      orderBy: [desc(pages.position)],
    });

    const newPosition = (lastPage?.position || 0) + 1;

    const validation = validatePageCreation(type as PageTypeEnum, {
      title,
      systemPrompt,
      enabledTools,
      aiProvider,
      aiModel,
    });

    if (!validation.valid) {
      return NextResponse.json({ error: validation.errors.join('. ') }, { status: 400 });
    }

    if (isAIChatPage(type) && enabledTools && enabledTools.length > 0) {
      const { pageSpaceTools } = await import('@/lib/ai/ai-tools');
      const availableToolNames = Object.keys(pageSpaceTools);
      const toolValidation = validateAIChatTools(enabledTools, availableToolNames);
      if (!toolValidation.valid) {
        return NextResponse.json({ error: toolValidation.errors.join('. ') }, { status: 400 });
      }
    }

    let defaultAiProvider: string | null = null;
    let defaultAiModel: string | null = null;

    if (isAIChatPage(type)) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: {
          currentAiProvider: true,
          currentAiModel: true,
        },
      });

      if (user) {
        defaultAiProvider = user.currentAiProvider || 'pagespace';
        defaultAiModel = user.currentAiModel || 'qwen/qwen3-coder:free';
      }
    }

    const newPage = await db.transaction(async (tx) => {
      interface APIPageInsertData {
        title: string;
        type: 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'SHEET';
        parentId: string | null;
        driveId: string;
        content: string;
        position: number;
        updatedAt: Date;
        aiProvider?: string | null;
        aiModel?: string | null;
        systemPrompt?: string | null;
        enabledTools?: string[] | null;
      }

      const pageData: APIPageInsertData = {
        title,
        type: type as 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'SHEET',
        parentId,
        driveId: drive.id,
        content: content || getDefaultContent(type as PageTypeEnum),
        position: newPosition,
        updatedAt: new Date(),
      };

      if (isAIChatPage(type)) {
        pageData.aiProvider = aiProvider || defaultAiProvider;
        pageData.aiModel = aiModel || defaultAiModel;

        if (systemPrompt) {
          pageData.systemPrompt = systemPrompt;
        }
        if (enabledTools && enabledTools.length > 0) {
          pageData.enabledTools = enabledTools;
        }
      }

      const [page] = await tx.insert(pages).values(pageData).returning();
      return page;
    });

    await broadcastPageEvent(
      createPageEventPayload(driveId, newPage.id, 'created', {
        parentId,
        title,
        type,
      }),
    );

    trackPageOperation(userId, 'create', newPage.id, {
      title,
      type,
      driveId: drive.id,
      parentId,
    });

    return NextResponse.json(newPage, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating page:', error as Error);
    return NextResponse.json({ error: 'Failed to create page' }, { status: 500 });
  }
}
