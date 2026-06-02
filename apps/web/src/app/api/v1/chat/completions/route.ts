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
  convertDbMessageToUIMessage,
} from '@/lib/ai/core';
import { incrementUsage } from '@/lib/subscription/usage-service';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { validateInferenceRequest } from '@/lib/ai/openai-api/validate-inference-request';
import { adaptToOpenAIChunk } from '@/lib/ai/openai-api/adapt-to-openai-chunk';
import { getProviderTier } from '@/lib/ai/core/ai-providers-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';

export const maxDuration = 300;

const AUTH_OPTIONS = { allow: ['mcp'] as const, requireCSRF: false };

export async function POST(request: Request): Promise<Response> {
  // 1. Authenticate — MCP tokens only; no session, no CSRF, no browser session ID
  const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(authResult)) {
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'openai_inference', resourceId: 'post', details: { reason: 'auth_failed', method: 'POST' }, riskScore: 0.5 });
    return authResult.error;
  }

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

  const { pageId, model: modelName, messages, driveContext: _driveContext, conversationId: incomingConversationId } = validation.data;

  // 3. MCP drive-scope check
  const scopeError = await checkMCPPageScope(authResult, pageId);
  if (scopeError) {
    auditRequest(request, { eventType: 'authz.access.denied', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { reason: 'mcp_page_scope_denied', method: 'POST' }, riskScore: 0.5 });
    return scopeError;
  }

  // 4. Load agent page
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page || page.type !== PageType.AI_CHAT) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  // 5. Permission check
  const canView = await canUserViewPage(authResult.userId, pageId);
  if (!canView) {
    auditRequest(request, { eventType: 'authz.access.denied', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { reason: 'no_view_permission', method: 'POST' }, riskScore: 0.5 });
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

  // 6b. Prepaid credit gate: block out-of-credits users before any model invocation.
  // Safe in billing-disabled deployments (returns unlimited) and lazy-inits balances.
  const [gateUser] = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, authResult.userId));
  const creditGate = await canConsumeAI(authResult.userId, (gateUser?.subscriptionTier ?? 'free') as SubscriptionTier);
  if (!creditGate.allowed) {
    auditRequest(request, { eventType: 'data.write', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { reason: 'out_of_credits' }, riskScore: 0 });
    return NextResponse.json(
      {
        error: 'out_of_credits',
        message: 'You have run out of AI credits. Add credits or wait for your monthly allowance to reset.',
      },
      { status: 402 }
    );
  }

  // 7. Build system prompt from agent page config
  const systemPrompt = page.systemPrompt
    ?? buildSystemPrompt('page', undefined, false);

  // 8. Build message context and save new user message
  const isThreadMode = incomingConversationId !== undefined;
  const conversationId = isThreadMode ? incomingConversationId : createId();
  const userMessage = messages[messages.length - 1];

  let inferenceMessages = messages;
  if (isThreadMode) {
    const dbMessages = await chatMessageRepository.getMessagesForPage(pageId, conversationId);
    inferenceMessages = [...dbMessages.map(convertDbMessageToUIMessage), userMessage];
  }

  const userMessageId = userMessage.id;
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

  auditRequest(request, { eventType: 'data.write', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { model: modelName, conversationId }, riskScore: 0 });

  // 9. Run inference — no UI coupling (no WebSocket, no stream lifecycle, no session ID)
  const startTime = Date.now();
  const providerType = getProviderTier(page.aiProvider ?? 'pagespace', page.aiModel ?? undefined);
  const sanitized = sanitizeMessagesForModel(inferenceMessages);
  const aiResult = streamText({
    model: providerResult.model,
    system: systemPrompt,
    messages: convertToModelMessages(sanitized),
    onFinish: async ({ text, totalUsage }) => {
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

      await AIMonitoring.trackUsage({
        userId: authResult.userId,
        provider: providerResult.provider,
        model: providerResult.modelName,
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
        duration: Date.now() - startTime,
        conversationId,
        messageId: assistantId,
        pageId,
        success: true,
        metadata: { via: 'openai_api_v1' },
      }).catch((err: unknown) => {
        loggers.ai.error('OpenAI API: failed to track usage', err as Error);
      });
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
        controller.close();
      } catch (err) {
        loggers.ai.error('OpenAI API: stream failed', err as Error);
        controller.error(err);
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
