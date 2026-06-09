import { NextResponse } from 'next/server';
import { streamText, convertToModelMessages, hasToolCall, stepCountIs, tool, jsonSchema } from 'ai';
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
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { buildSystemPrompt } from '@/lib/ai/core/system-prompt';
import { sanitizeMessagesForModel, saveMessageToDatabase, extractMessageContent, convertDbMessageToUIMessage, extractToolResults } from '@/lib/ai/core/message-utils';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import { filterToolsForReadOnly } from '@/lib/ai/core/tool-filtering';
import { getModelCapabilities } from '@/lib/ai/core/model-capabilities';
import { applyToolExposureMode } from '@/lib/ai/tools/tool-exposure';
import { finishTool, FINISH_TOOL_NAME } from '@/lib/ai/tools/finish-tool';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { validateInferenceRequest } from '@/lib/ai/openai-api/validate-inference-request';
import { adaptToOpenAIChunk } from '@/lib/ai/openai-api/adapt-to-openai-chunk';
import { buildToolSummaryEvent } from '@/lib/ai/openai-api/build-tool-summary-event';
import { validateConversationAccess } from '@/lib/ai/openai-api/v1-conversations';
import { extractToolCallsFromSteps } from '@/lib/ai/openai-api/extract-tool-calls-from-steps';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { AIMonitoring, extractOpenRouterCostDollars, extractOpenRouterGenerationIds } from '@pagespace/lib/monitoring/ai-monitoring';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
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

  const { pageId, model: modelName, messages, driveContext: _driveContext, conversationId: incomingConversationId, clientTools: rawClientTools, disableServerTools, clientManagesHistory } = validation.data;

  // Build the caller's client-side tool set. Tools registered without `execute` are returned
  // to the caller as native tool_calls — the SDK pauses, the caller executes locally, and the
  // conversation resumes via role:tool messages (see multi-turn conversation API, PR #1552).
  const clientToolSet: ToolSet = {};
  for (const def of rawClientTools ?? []) {
    clientToolSet[def.function.name] = tool({
      description: def.function.description ?? '',
      inputSchema: jsonSchema(def.function.parameters ?? { type: 'object', properties: {} }),
      // No execute — signals to the SDK to return this call to the caller.
    }) as ToolSet[string];
  }
  const hasClientTools = Object.keys(clientToolSet).length > 0;
  const useServerTools = !disableServerTools;

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

  // 5b. Conversation ownership check — if a conversation_id is provided the caller
  // must own the conversations row. This prevents one user from appending messages
  // into another user's thread.
  //
  // client_manages_history callers (e.g. pi) manage their own context window and may
  // supply a brand-new conversation_id. When the row doesn't exist yet we auto-create it
  // here (not deferred) so we can immediately re-read and catch a TOCTOU race where two
  // requests collide on the same new ID. We still 403 on wrong owner and 404 on inactive.
  if (incomingConversationId) {
    const conv = await conversationRepository.getConversation(incomingConversationId);
    if (clientManagesHistory) {
      if (conv) {
        // Row exists — apply the same isActive + ownership checks as the normal path.
        if (!conv.isActive) {
          return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
        }
        if (conv.userId !== authResult.userId) {
          return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }
      } else {
        // First use: create the row then re-read to verify ownership, guarding against
        // the unlikely TOCTOU case where two requests race on the same new UUID.
        await conversationRepository.createConversation(incomingConversationId, authResult.userId, pageId);
        const owned = await conversationRepository.getConversation(incomingConversationId);
        if (!owned || owned.userId !== authResult.userId) {
          return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }
      }
    } else {
      const convAccess = validateConversationAccess(conv, authResult.userId);
      if (!convAccess.ok) {
        return NextResponse.json({ error: convAccess.message }, { status: convAccess.status });
      }
    }
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
  const creditGate = await canConsumeAI(authResult.userId, (gateUser?.subscriptionTier ?? 'free') as SubscriptionTier, {
    estCostCents: estimateChatHoldCentsForModel(page.aiModel ?? undefined),
    maxInFlight: MAX_CHAT_INFLIGHT,
  });
  if (!creditGate.allowed) {
    auditRequest(request, { eventType: 'data.write', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { reason: creditGate.reason }, riskScore: 0 });
    return creditGateErrorResponse(creditGate.reason);
  }
  // The gate's reservation for this call, released when usage is billed in onFinish.
  const holdId = creditGate.holdId;

  // 7. Build system prompt from agent page config
  const systemPrompt = page.systemPrompt
    ?? buildSystemPrompt('page', undefined, false);

  // 7b. Build the final tool set and stop conditions based on the request mode:
  //   server-only (useServerTools && !hasClientTools)  — full PageSpace tools + finish tool (default)
  //   client-only (!useServerTools) — caller tools only, or empty if no client tools provided
  //   both        (useServerTools && hasClientTools) — merged; client wins on name collision
  // Client modes skip the finish tool because the caller controls the conversation externally;
  // each round-trip is a new request and the finish tool would conflict with that flow.
  // disable_server_tools is honoured independently of whether client tools are present:
  //   disable_server_tools:true with no tools → no tools at all (model generates text only).
  const agentEnabledTools = page.enabledTools as string[] | null;
  const toolExposureMode = (page.toolExposureMode as 'upfront' | 'search' | null) ?? 'upfront';

  const inServerOnlyMode = useServerTools && !hasClientTools;

  let finalTools: ToolSet;
  let toolDiscoveryPrompt = '';
  const stopConditions = inServerOnlyMode
    ? [hasToolCall(FINISH_TOOL_NAME), stepCountIs(100)]
    : [stepCountIs(100)];

  if (inServerOnlyMode) {
    // server-only: existing pipeline unchanged
    const baseTools = filterToolsForReadOnly(pageSpaceTools, false);
    let filteredTools: ToolSet =
      agentEnabledTools != null
        ? (Object.fromEntries(
            Object.entries(baseTools).filter(([name]) => agentEnabledTools.includes(name)),
          ) as ToolSet)
        : (baseTools as ToolSet);
    const exposure = applyToolExposureMode(filteredTools, toolExposureMode, ALWAYS_UPFRONT_TOOLS);
    filteredTools = exposure.tools;
    toolDiscoveryPrompt = exposure.toolDiscoveryPrompt;
    finalTools = { ...filteredTools, ...finishTool } as ToolSet;
  } else if (!useServerTools) {
    // client-only or no-tools: just client tools (may be empty when disable_server_tools=true but no tools provided)
    finalTools = clientToolSet;
  } else {
    // both: server tools + client tools; client wins on name collision
    const baseTools = filterToolsForReadOnly(pageSpaceTools, false);
    let filteredTools: ToolSet =
      agentEnabledTools != null
        ? (Object.fromEntries(
            Object.entries(baseTools).filter(([name]) => agentEnabledTools.includes(name)),
          ) as ToolSet)
        : (baseTools as ToolSet);
    const exposure = applyToolExposureMode(filteredTools, toolExposureMode, ALWAYS_UPFRONT_TOOLS);
    filteredTools = exposure.tools;
    toolDiscoveryPrompt = exposure.toolDiscoveryPrompt;
    finalTools = { ...filteredTools, ...clientToolSet } as ToolSet;
  }

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
  if (isThreadMode && !clientManagesHistory) {
    const dbMessages = await chatMessageRepository.getMessagesForPage(pageId, conversationId);
    inferenceMessages = [...dbMessages.map(convertDbMessageToUIMessage), userMessage];
  }

  // Back-fill: when the client manages full history, sweep all prior assistant messages
  // for completed tool results and persist them. normalizeMessages collapses role:tool
  // pairs into assistant UIMessages with output-available parts — those results were
  // executed by the client on earlier turns but never reached the DB.
  if (clientManagesHistory && isThreadMode) {
    const priorMessages = messages.slice(0, -1);
    for (const msg of priorMessages) {
      if (msg.role !== 'assistant') continue;
      const toolResults = extractToolResults(msg);
      if (toolResults.length === 0) continue;
      chatMessageRepository.updateMessageToolResults(msg.id, conversationId, toolResults)
        .catch((err: unknown) => loggers.ai.error('OpenAI API: failed to back-fill tool results', err as Error));
    }
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

  // OpenAI-style callers may supply their own system message(s) in the request.
  // sanitizeMessagesForModel strips system-role messages from the array (system content
  // must ride in the `system:` option, not messages[], per AI SDK prompt-injection
  // hardening), so hoist any caller system instructions into the system prompt first —
  // dropping them silently would break standard OpenAI clients.
  const callerSystemPrompt = inferenceMessages
    .filter(m => m.role === 'system')
    .map(extractMessageContent)
    .filter(Boolean)
    .join('\n\n');
  const sanitized = sanitizeMessagesForModel(inferenceMessages);

  // Standard OpenAI-style cancel: the consumer closing the HTTP connection stops generation.
  // Next.js fires request.signal on disconnect; the ReadableStream's cancel() (below) is a
  // belt-and-suspenders path for disconnects detected at the response-stream layer.
  const abortController = new AbortController();
  if (request.signal.aborted) {
    // The consumer already dropped the connection during the pre-stream setup above.
    // addEventListener won't replay a past abort, so trip the controller now — otherwise
    // streamText would receive a non-aborted signal and burn tokens for a gone client.
    abortController.abort();
  } else {
    request.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  // Settle billing exactly once. streamText.onFinish does NOT fire on abort (onAbort does),
  // so both callbacks funnel through here. Tokens burned before an abort are real provider
  // spend, so we bill them and release the gate's hold in the same path.
  let settled = false;
  let assistantText = '';
  const settle = async ({ aborted, text, totalUsage, steps }: {
    aborted: boolean;
    text?: string;
    totalUsage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number };
    steps?: unknown[];
  }) => {
    if (settled) return;
    settled = true;

    const assistantId = createId();
    const extracted = extractToolCallsFromSteps(steps ?? []);
    const hasContent = text !== undefined || extracted.toolCalls.length > 0;
    if (hasContent) {
      await saveMessageToDatabase({
        messageId: assistantId,
        pageId,
        conversationId,
        userId: null,
        role: 'assistant',
        content: text ?? '',
        toolCalls: extracted.toolCalls.length > 0 ? extracted.toolCalls : undefined,
        toolResults: extracted.toolResults.length > 0 ? extracted.toolResults : undefined,
      }).catch((err: unknown) => {
        loggers.ai.error('OpenAI API: failed to save assistant message', err as Error);
      });
    }

    // trackUsage -> consumeCredits decrements the balance and deletes the hold in one
    // transaction (idempotent if the hold is already gone).
    await AIMonitoring.trackUsage({
      userId: authResult.userId,
      provider: providerResult.provider,
      model: providerResult.modelName,
      source: 'chat',
      inputTokens: totalUsage?.inputTokens,
      outputTokens: totalUsage?.outputTokens,
      cachedInputTokens: totalUsage?.cachedInputTokens,
      reasoningTokens: totalUsage?.reasoningTokens,
      providerCostDollars: extractOpenRouterCostDollars(steps as Parameters<typeof extractOpenRouterCostDollars>[0]),
      openrouterGenerationIds: extractOpenRouterGenerationIds(steps as Parameters<typeof extractOpenRouterGenerationIds>[0]),
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
    system: systemPrompt + (callerSystemPrompt ? `\n\n${callerSystemPrompt}` : '') + toolDiscoveryPrompt,
    messages: convertToModelMessages(sanitized),
    tools: finalTools,
    stopWhen: stopConditions,
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
  });

  // 10. Stream response as OpenAI SSE
  const completionId = `chatcmpl-${createId()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Per-step tool call state: tracks tool index and presence for finish-step finish_reason
      let stepToolCallIndex = 0;
      let stepHadToolCalls = false;
      // Client-tool tracking: detect when the stream ends on a client-side tool call so we
      // can emit finish_reason:'tool_calls' instead of 'stop' on the final finish chunk.
      const clientToolNames = new Set(Object.keys(clientToolSet));
      let hadClientToolThisStep = false;
      let streamEndedOnClientTool = false;

      try {
        for await (const chunk of aiResult.toUIMessageStream()) {
          if (chunk.type === 'text-delta') assistantText += chunk.delta;

          // Reset per-step state at the start of each inference step
          if (chunk.type === 'start-step') {
            stepToolCallIndex = 0;
            stepHadToolCalls = false;
            hadClientToolThisStep = false;
          }

          // Capture index before increment so the emitted chunk gets the right index
          const toolCallIndex = stepToolCallIndex;
          if (chunk.type === 'tool-input-available') {
            stepHadToolCalls = true;
            stepToolCallIndex++;
            if (clientToolNames.has(chunk.toolName)) {
              hadClientToolThisStep = true;
            }
          }

          if (chunk.type === 'finish-step' && hadClientToolThisStep) {
            streamEndedOnClientTool = true;
          }

          const line = adaptToOpenAIChunk(chunk, {
            id: completionId,
            model: modelName,
            created,
            toolCallIndex,
            hadToolCallsInStep: stepHadToolCalls,
            overrideFinishReason: chunk.type === 'finish' && streamEndedOnClientTool ? 'tool_calls' : undefined,
          });
          if (line) {
            controller.enqueue(encoder.encode(line + '\n\n'));
          }
        }
        // A consumer abort ends the stream gracefully (the SDK emits an abort part) rather
        // than throwing, so settlement happens here for both normal finish and abort. Doing
        // it inside the stream lifecycle — and awaiting it before closing — ensures billing
        // and hold release complete before the response ends, instead of racing a detached
        // callback that a serverless runtime may freeze after the connection drops.
        const aborted = abortController.signal.aborted;
        if (aborted) {
          loggers.ai.info('OpenAI API: stream aborted by consumer', { pageId, conversationId });
        }
        const totalUsage = await aiResult.totalUsage.catch(() => undefined);
        const steps = await aiResult.steps.catch(() => undefined);
        await settle({ aborted, text: assistantText || undefined, totalUsage, steps });
        if (!aborted) {
          const toolSummary = buildToolSummaryEvent(steps ?? []);
          if (toolSummary) {
            controller.enqueue(encoder.encode(toolSummary + '\n\n'));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
        controller.close();
      } catch (err) {
        // Some providers surface an abort as a thrown AbortError instead. Treat it as a
        // clean stop and settle the partial usage the same way.
        if (abortController.signal.aborted) {
          loggers.ai.info('OpenAI API: stream aborted by consumer', { pageId, conversationId });
          const totalUsage = await aiResult.totalUsage.catch(() => undefined);
          const steps = await aiResult.steps.catch(() => undefined);
          await settle({ aborted: true, text: assistantText || undefined, totalUsage, steps });
          controller.close();
          return;
        }
        loggers.ai.error('OpenAI API: stream failed', err as Error);
        // The stream errored before settlement, so the gate's reservation would otherwise
        // linger until TTL/reconcile — leaving the user artificially short on credits.
        // Release it now (idempotent if already settled).
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
