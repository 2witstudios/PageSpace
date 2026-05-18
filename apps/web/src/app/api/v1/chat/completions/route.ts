import { NextResponse } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { PageType } from '@pagespace/lib/utils/enums';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPPageScope,
} from '@/lib/auth';
import {
  createAIProvider,
  buildSystemPrompt,
  sanitizeMessagesForModel,
  saveMessageToDatabase,
  extractMessageContent,
  isProviderError,
} from '@/lib/ai/core';
import { incrementUsage } from '@/lib/subscription/usage-service';
import { validateInferenceRequest } from '@/lib/ai/openai-api/validate-inference-request';
import { adaptToOpenAIChunk } from '@/lib/ai/openai-api/adapt-to-openai-chunk';
import { getProviderTier } from '@/lib/ai/core/ai-providers-config';

export const maxDuration = 300;

const AUTH_OPTIONS = { allow: ['mcp'] as const, requireCSRF: false };

export async function POST(request: Request): Promise<Response> {
  // 1. Authenticate — MCP tokens only; no session, no CSRF, no browser session ID
  const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(authResult)) return authResult.error;

  // 2. Validate request body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validation = validateInferenceRequest(rawBody);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: validation.status });
  }

  const { pageId, messages, driveContext: _driveContext } = validation.data;
  const rawBodyTyped = rawBody as Record<string, unknown>;
  const modelName = rawBodyTyped.model as string;

  // 3. MCP drive-scope check
  const scopeError = await checkMCPPageScope(authResult, pageId);
  if (scopeError) return scopeError;

  // 4. Load agent page
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page || page.type !== PageType.AI_CHAT) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  // 5. Permission check
  const canView = await canUserViewPage(authResult.userId, pageId);
  if (!canView) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  // 6. Create AI provider from agent page config
  const providerResult = await createAIProvider(authResult.userId, {
    selectedProvider: page.aiProvider ?? undefined,
    selectedModel: page.aiModel ?? undefined,
  });
  if (isProviderError(providerResult)) {
    return NextResponse.json({ error: providerResult.error }, { status: providerResult.status });
  }

  // 7. Build system prompt from agent page config
  const systemPrompt = page.systemPrompt
    ?? buildSystemPrompt('page', undefined, false);

  // 8. Save user message (database-first — before streaming starts)
  const userMessage = messages[messages.length - 1];
  const conversationId = createId();
  const userMessageId = userMessage.id ?? createId();
  if (userMessage && userMessage.role === 'user') {
    await saveMessageToDatabase({
      messageId: userMessageId,
      pageId,
      conversationId,
      userId: authResult.userId,
      role: 'user',
      content: extractMessageContent(userMessage),
      uiMessage: userMessage,
    });
  }

  // 9. Run inference — no UI coupling (no WebSocket, no stream lifecycle, no session ID)
  const providerType = getProviderTier(page.aiProvider ?? 'pagespace', page.aiModel ?? undefined);
  const sanitized = sanitizeMessagesForModel(messages);
  const aiResult = streamText({
    model: providerResult.model,
    system: systemPrompt,
    messages: convertToModelMessages(sanitized),
    onFinish: async ({ text }) => {
      const assistantId = createId();
      await saveMessageToDatabase({
        messageId: assistantId,
        pageId,
        conversationId,
        userId: null,
        role: 'assistant',
        content: text,
      }).catch((err: unknown) => {
        loggers.ai.error('OpenAI API: failed to save assistant message', err as Error);
      });

      if (authResult.userId) {
        await incrementUsage(authResult.userId, providerType).catch((err: unknown) => {
          loggers.ai.error('OpenAI API: failed to increment usage', err as Error);
        });
      }
    },
  });

  // 10. Stream response as OpenAI SSE
  const completionId = `chatcmpl-${createId()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of aiResult.toUIMessageStream()) {
          const line = adaptToOpenAIChunk(chunk, { id: completionId, model: modelName, created });
          if (line) {
            controller.enqueue(encoder.encode(line + '\n\n'));
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
