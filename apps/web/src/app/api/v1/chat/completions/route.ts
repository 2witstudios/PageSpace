import { NextResponse } from 'next/server';
import { streamText, convertToModelMessages, hasToolCall, stepCountIs } from 'ai';
import type { ToolSet } from 'ai';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { PageType } from '@pagespace/lib/utils/enums';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPPageScope,
  getAllowedDriveIds,
} from '@/lib/auth';
import {
  createAIProvider,
  buildSystemPrompt,
  sanitizeMessagesForModel,
  saveMessageToDatabase,
  extractMessageContent,
  isProviderError,
  convertDbMessageToUIMessage,
  pageSpaceTools,
  filterToolsForReadOnly,
  getModelCapabilities,
} from '@/lib/ai/core';
import { applyToolExposureMode } from '@/lib/ai/tools/tool-exposure';
import { finishTool, FINISH_TOOL_NAME } from '@/lib/ai/tools/finish-tool';
import { incrementUsage } from '@/lib/subscription/usage-service';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { validateInferenceRequest } from '@/lib/ai/openai-api/validate-inference-request';
import { adaptToOpenAIChunk } from '@/lib/ai/openai-api/adapt-to-openai-chunk';
import { getProviderTier } from '@/lib/ai/core/ai-providers-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { AIMonitoring, extractOpenRouterCostDollars } from '@pagespace/lib/monitoring/ai-monitoring';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { creditGateErrorResponse } from '@/lib/subscription/credit-gate-response';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';

export const maxDuration = 300;

const AUTH_OPTIONS = { allow: ['mcp'] as const, requireCSRF: false };

// Runtime-toggled tools that must stay directly callable even in search mode.
const ALWAYS_UPFRONT_TOOLS = new Set(['web_search']);

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

  // 5. Permission check. View is necessary but not sufficient: this endpoint runs
  // the agent's server-side tools (including write tools) with the agent page as the
  // actor, so it requires the same edit gate the in-app page chat enforces before
  // sending a message. A view-only caller must not be able to drive writes.
  const canView = await canUserViewPage(authResult.userId, pageId);
  if (!canView) {
    auditRequest(request, { eventType: 'authz.access.denied', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { reason: 'no_view_permission', method: 'POST' }, riskScore: 0.5 });
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }
  const canEdit = await canUserEditPage(authResult.userId, pageId);
  if (!canEdit) {
    auditRequest(request, { eventType: 'authz.access.denied', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { reason: 'no_edit_permission', method: 'POST' }, riskScore: 0.5 });
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
    auditRequest(request, { eventType: 'data.write', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { reason: creditGate.reason }, riskScore: 0 });
    return creditGateErrorResponse(creditGate.reason);
  }
  // The gate's reservation for this call, released when usage is billed in onFinish.
  const holdId = creditGate.holdId;

  // 7. Build system prompt from agent page config
  const systemPrompt = page.systemPrompt
    ?? buildSystemPrompt('page', undefined, false);

  // 7b. Build the agent's server-side tool set (mirrors /api/ai/chat).
  // The OpenAI request shape carries no read-only / web-search toggles, so
  // read-only defaults to false; web_search falls through the allowlist.
  const baseTools = filterToolsForReadOnly(pageSpaceTools, false);
  // Per-agent allowlist: null/undefined = unrestricted; [] = none; [names] = only those.
  const agentEnabledTools = page.enabledTools as string[] | null;
  let filteredTools: ToolSet =
    agentEnabledTools != null
      ? (Object.fromEntries(
          Object.entries(baseTools).filter(([name]) => agentEnabledTools.includes(name)),
        ) as ToolSet)
      : (baseTools as ToolSet);
  // Exposure mode: 'upfront' (default) hands every tool over; 'search' defers
  // non-core tools behind tool_search/execute_tool.
  const toolExposureMode = (page.toolExposureMode as 'upfront' | 'search' | null) ?? 'upfront';
  const exposure = applyToolExposureMode(filteredTools, toolExposureMode, ALWAYS_UPFRONT_TOOLS);
  filteredTools = exposure.tools;
  const toolDiscoveryPrompt = exposure.toolDiscoveryPrompt;
  // Always inject the finish tool so the agentic loop can terminate cleanly.
  filteredTools = { ...filteredTools, ...finishTool } as ToolSet;

  // Load the caller's timezone so time-aware tools (calendar, task triggers)
  // resolve dates in the user's zone instead of defaulting to UTC, matching
  // the in-app page chat (apps/web/src/app/api/ai/chat/route.ts:833).
  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, authResult.userId));
  const userTimezone = user?.timezone ?? undefined;

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

  // Standard OpenAI-style cancel: the consumer closing the HTTP connection stops generation.
  // Next.js fires request.signal on disconnect; the ReadableStream's cancel() (below) is a
  // belt-and-suspenders path for disconnects detected at the response-stream layer.
  const abortController = new AbortController();
  request.signal.addEventListener('abort', () => abortController.abort(), { once: true });

  // Settle billing exactly once. streamText.onFinish does NOT fire on abort (onAbort does),
  // so both callbacks funnel through here. Tokens burned before an abort are real provider
  // spend, so we bill them and release the gate's hold in the same path.
  let settled = false;
  let assistantText = '';
  const settle = async ({ aborted, text, totalUsage, steps }: {
    aborted: boolean;
    text?: string;
    totalUsage?: { inputTokens?: number; outputTokens?: number };
    steps?: unknown[];
  }) => {
    if (settled) return;
    settled = true;

    const assistantId = createId();
    if (text) {
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
    }

    if (authResult.userId) {
      await incrementUsage(authResult.userId, providerType).catch((err: unknown) => {
        loggers.ai.error('OpenAI API: failed to increment usage', err as Error);
      });
    }

    // trackUsage -> consumeCredits decrements the balance and deletes the hold in one
    // transaction (idempotent if the hold is already gone).
    await AIMonitoring.trackUsage({
      userId: authResult.userId,
      provider: providerResult.provider,
      model: providerResult.modelName,
      inputTokens: totalUsage?.inputTokens,
      outputTokens: totalUsage?.outputTokens,
      providerCostDollars: extractOpenRouterCostDollars(steps as Parameters<typeof extractOpenRouterCostDollars>[0]),
      duration: Date.now() - startTime,
      conversationId,
      messageId: assistantId,
      pageId,
      success: !aborted,
      holdId,
      metadata: { via: 'openai_api_v1', ...(aborted ? { aborted: true } : {}) },
    }).catch((err: unknown) => {
      loggers.ai.error('OpenAI API: failed to track usage', err as Error);
    });
  };

  const aiResult = streamText({
    model: providerResult.model,
    system: systemPrompt + toolDiscoveryPrompt,
    messages: convertToModelMessages(sanitized),
    tools: filteredTools,
    stopWhen: [hasToolCall(FINISH_TOOL_NAME), stepCountIs(100)],
    // Aborts when the consumer closes the connection (see abortController above).
    abortSignal: abortController.signal,
    experimental_context: {
      userId: authResult.userId,
      conversationId,
      timezone: userTimezone,
      aiProvider: page.aiProvider ?? undefined,
      aiModel: page.aiModel ?? undefined,
      modelCapabilities: await getModelCapabilities(
        providerResult.modelName,
        providerResult.provider,
      ),
      chatSource: { type: 'page' as const, agentPageId: pageId, agentTitle: page.title },
      enabledTools: agentEnabledTools ?? null,
      // Bind tool execution to the MCP token's drive scope so a scoped token
      // cannot reach drives outside its scope via the agent's broader ACL.
      mcpAllowedDriveIds: getAllowedDriveIds(authResult),
    },
    maxRetries: 20,
    onFinish: async ({ text, totalUsage, steps }) => {
      await settle({ aborted: false, text, totalUsage, steps });
    },
    onAbort: () => {
      // Settle partial usage off the SDK's resolved promises (they resolve even on abort,
      // matching chat/route.ts's usagePromise/stepsPromise approach). Fire-and-forget so the
      // abort callback stays light; the `settled` guard keeps it single-shot.
      void (async () => {
        const totalUsage = await aiResult.totalUsage.catch(() => undefined);
        const steps = await aiResult.steps.catch(() => undefined);
        loggers.ai.info('OpenAI API: stream aborted by consumer', { pageId, conversationId });
        await settle({ aborted: true, text: assistantText || undefined, totalUsage, steps });
      })();
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
          if (chunk.type === 'text-delta') assistantText += chunk.delta;
          const line = adaptToOpenAIChunk(chunk, { id: completionId, model: modelName, created });
          if (line) {
            controller.enqueue(encoder.encode(line + '\n\n'));
          }
        }
        controller.close();
      } catch (err) {
        // A consumer abort surfaces here as an AbortError once the SDK tears the stream
        // down. onAbort already settled billing/hold, so just close cleanly.
        if (abortController.signal.aborted) {
          controller.close();
          return;
        }
        loggers.ai.error('OpenAI API: stream failed', err as Error);
        // The stream errored before onFinish could settle the charge, so the gate's
        // reservation would otherwise linger until TTL/reconcile — leaving the user
        // artificially short on credits. Release it now (idempotent if already settled).
        if (!settled && holdId) await releaseHold(holdId).catch(() => {});
        controller.error(err);
      }
    },
    cancel() {
      // Consumer closed the connection mid-stream: stop the model.
      abortController.abort();
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
