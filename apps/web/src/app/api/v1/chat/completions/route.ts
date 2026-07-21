import { NextResponse } from 'next/server';
import { streamText, convertToModelMessages, hasToolCall, stepCountIs, tool, jsonSchema } from 'ai';
import type { ToolSet, ModelMessage } from 'ai';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { PageType } from '@pagespace/lib/utils/enums';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  authenticateRequestWithOptions,
  isAuthError,
  isMCPAuthResult,
  checkMCPPageScope,
  getAllowedDriveIds,
  isScopedMCPAuth,
  canPrincipalViewPage,
  canPrincipalEditPage,
} from '@/lib/auth';
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { buildSystemPrompt } from '@/lib/ai/core/system-prompt';
import { sanitizeMessagesForModel, saveMessageToDatabase, extractMessageContent, convertDbMessageToUIMessage, extractToolResults } from '@/lib/ai/core/message-utils';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import { filterToolsForReadOnly, filterToolsForMcpScope, filterToolsForImageGen } from '@/lib/ai/core/tool-filtering';
import { getModelCapabilities, hasVisionCapability } from '@/lib/ai/core/model-capabilities';
import { hasFileParts, validateUserMessageFileParts } from '@/lib/ai/core/validate-image-parts';
import { applyToolExposureMode } from '@/lib/ai/tools/tool-exposure';
import { finishTool, FINISH_TOOL_NAME } from '@/lib/ai/tools/finish-tool';
import { guardReadPageToolForVision } from '@/lib/ai/tools/read-page-vision-output';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { validateInferenceRequest } from '@/lib/ai/openai-api/validate-inference-request';
import { adaptToOpenAIChunk } from '@/lib/ai/openai-api/adapt-to-openai-chunk';
import { buildToolSummaryEvent } from '@/lib/ai/openai-api/build-tool-summary-event';
import { validateConversationAccess } from '@/lib/ai/openai-api/v1-conversations';
import { extractToolCallsFromSteps } from '@/lib/ai/openai-api/extract-tool-calls-from-steps';
import { resolveHoldDisposition } from '@/lib/ai/openai-api/resolve-hold-disposition';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { AIMonitoring, extractOpenRouterCostDollars, extractOpenRouterGenerationIds } from '@pagespace/lib/monitoring/ai-monitoring';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { isMeteringExempt } from '@pagespace/lib/ai/model-defaults';
import { ADMIN_ONLY_PROVIDERS } from '@/lib/ai/core/ai-providers-config';
import { createAdminRestrictedResponse } from '@/lib/subscription/rate-limit-middleware';
import { MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { creditGateErrorResponse } from '@/lib/subscription/credit-gate-response';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { prepareHistoryForModel, finishModelRequest } from '@/lib/ai/core/context-assembly';

export const maxDuration = 300;

const AUTH_OPTIONS = { allow: ['mcp'] as const, requireCSRF: false };

// Runtime-toggled tools that must stay directly callable even in search mode.
const ALWAYS_UPFRONT_TOOLS = new Set(['web_search']);

export async function POST(request: Request): Promise<Response> {
  // 1. Authenticate — MCP tokens only; no session, no CSRF, no browser session ID
  const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(authResult)) {
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'openai_inference', resourceId: 'post', details: { reason: 'auth_failed', method: 'POST', authFailureReason: authResult.authFailureReason }, riskScore: 0.5 });
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
  const canView = await canPrincipalViewPage(authResult, pageId);
  if (!canView) {
    auditRequest(request, { eventType: 'authz.access.denied', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { reason: 'no_view_permission', method: 'POST' }, riskScore: 0.5 });
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }
  const canEdit = await canPrincipalEditPage(authResult, pageId);
  if (!canEdit) {
    auditRequest(request, { eventType: 'authz.access.denied', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { reason: 'no_edit_permission', method: 'POST' }, riskScore: 0.5 });
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  // 5b. Image security gate — mirrors the in-app chat route
  // (apps/web/src/app/api/ai/chat/route.ts). Runs after the permission checks so an
  // unauthorized caller gets the 403 and never learns anything page-specific from image
  // errors, and before the credit hold (6b) so a rejected image never reserves a hold or
  // an in-flight slot. EVERY message in the request body is validated — not just the
  // newest one (non-threaded and client_manages_history callers resend full history) and
  // not just user-role ones: normalizeMessage passes pre-built `parts` arrays through
  // as-is and the AI SDK forwards assistant file parts to the provider exactly like user
  // ones, so an assistant-role message must not bypass the data:-URL/size/magic-byte rules.
  const messagesWithFileParts = messages.filter(m => hasFileParts(m));
  for (const messageWithFileParts of messagesWithFileParts) {
    const imageValidation = validateUserMessageFileParts(messageWithFileParts);
    if (!imageValidation.valid) {
      return NextResponse.json({ error: imageValidation.error }, { status: 400 });
    }
  }
  const requestHasImageParts = messagesWithFileParts.length > 0;

  // 5c. Conversation ownership check — if a conversation_id is provided the caller
  // must own the conversations row. This prevents one user from appending messages
  // into another user's thread.
  //
  // client_manages_history callers (e.g. pi) manage their own context window and may
  // supply a brand-new conversation_id. When the row doesn't exist yet we auto-create it
  // here (not deferred) so we can immediately re-read and catch a TOCTOU race where two
  // requests collide on the same new ID. We still 403 on wrong owner and 404 on inactive.
  // Fail-closed: private by default. Only shared conversations get mention notifications.
  let isConversationShared = false;
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
        isConversationShared = conv.isShared === true;
      } else {
        // First use: create the row then re-read to verify ownership, guarding against
        // the unlikely TOCTOU case where two requests race on the same new UUID.
        await conversationRepository.createConversation(incomingConversationId, authResult.userId, pageId);
        const owned = await conversationRepository.getConversation(incomingConversationId);
        if (!owned || !owned.isActive) {
          return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
        }
        if (owned.userId !== authResult.userId) {
          return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }
        // newly created rows are always isShared: false — isConversationShared stays false
      }
    } else {
      const convAccess = validateConversationAccess(conv, authResult.userId);
      if (!convAccess.ok) {
        return NextResponse.json({ error: convAccess.message }, { status: convAccess.status });
      }
      isConversationShared = conv?.isShared === true;
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

  // The resolved provider that will ACTUALLY run (post catalog-substitution): an
  // agent configured with `glm` + an invalid model resolves to the metered default,
  // so both the admin gate and the credit gate below key off this, not the raw config.
  const effectiveProvider = providerResult.provider;

  // 6a. Vision-capability gate — judged against the RESOLVED model (post
  // catalog-substitution), not the raw page config: a null or invalid configured model
  // resolves to a real default, and that resolved model is what the images will actually
  // reach. Still before the credit hold (6b) so a rejected image never reserves a hold
  // or an in-flight slot.
  if (requestHasImageParts && !hasVisionCapability(providerResult.modelName)) {
    return NextResponse.json(
      { error: `The selected model "${providerResult.modelName}" does not support image attachments. Please choose a vision-capable model.` },
      { status: 400 },
    );
  }

  // 6b. Prepaid credit gate: block out-of-credits users before any model invocation.
  // Safe in billing-disabled deployments (returns unlimited) and lazy-inits balances.
  const [gateUser] = await db
    .select({ subscriptionTier: users.subscriptionTier, role: users.role })
    .from(users)
    .where(eq(users.id, authResult.userId));

  // Admin-only providers (the direct Z.ai Coder Plan) are unmetered and must never be
  // reachable by a non-admin — otherwise any user able to drive a glm-configured agent
  // could consume the admin subscription for free. The interactive chat routes enforce
  // this; this MCP inference route must too.
  if (ADMIN_ONLY_PROVIDERS.has(effectiveProvider) && gateUser?.role !== 'admin') {
    auditRequest(request, { eventType: 'authz.access.denied', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { reason: 'admin_only_provider', provider: effectiveProvider, method: 'POST' }, riskScore: 0.5 });
    return createAdminRestrictedResponse();
  }

  // The gate's reservation for this call, released when usage is billed in onFinish.
  // Metering-exempt providers (admin Z.ai Coder Plan) bill on a flat-rate external
  // subscription, so skip the gate entirely — no hold, no balance check — and never
  // debit at settle (see isMeteringExempt in trackAIUsage).
  let holdId: string | undefined;
  if (!isMeteringExempt(effectiveProvider)) {
    const creditGate = await canConsumeAI(authResult.userId, (gateUser?.subscriptionTier ?? 'free') as SubscriptionTier, {
      estCostCents: estimateChatHoldCentsForModel(page.aiModel ?? undefined),
      maxInFlight: MAX_CHAT_INFLIGHT,
    });
    if (!creditGate.allowed) {
      auditRequest(request, { eventType: 'data.write', userId: authResult.userId, resourceType: 'openai_inference', resourceId: pageId, details: { reason: creditGate.reason }, riskScore: 0 });
      return creditGateErrorResponse(creditGate.reason);
    }
    holdId = creditGate.holdId;
  }

  // Ownership of the hold transfers to the streaming lifecycle only once we return the
  // streaming Response (set just before `return new Response`). Until then, ANY throw in the
  // setup below — capabilities lookup, convertToModelMessages, message persistence — must
  // free the hold, or a pre-stream failure strands the user's credits plus an in-flight slot
  // until CREDIT_HOLD_TTL_SECONDS expires (L6). The finally enforces that.
  let holdHandedOff = false;
  try {
    // 7. Build system prompt from agent page config
    const systemPrompt = page.systemPrompt
      ?? buildSystemPrompt(false);

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

    // Hide account-level-only tools (e.g. create_drive) from a drive-scoped MCP token's tool list.
    const isMcpScopedRequest = isScopedMCPAuth(authResult);

    if (inServerOnlyMode) {
      // server-only: existing pipeline unchanged
      // Image generation is in an ADMIN-ONLY rollout and is exposed solely through the
      // chat/global routes' explicit toggle — never through the OpenAI-compatible API.
      const baseTools = filterToolsForImageGen(
        filterToolsForMcpScope(filterToolsForReadOnly(pageSpaceTools, false), isMcpScopedRequest),
        false,
      );
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
      // Image generation is in an ADMIN-ONLY rollout and is exposed solely through the
      // chat/global routes' explicit toggle — never through the OpenAI-compatible API.
      const baseTools = filterToolsForImageGen(
        filterToolsForMcpScope(filterToolsForReadOnly(pageSpaceTools, false), isMcpScopedRequest),
        false,
      );
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

    // Guard against a stale read_page tool-result (image bytes delivered on an
    // earlier turn/request when the model had vision) being re-embedded as an
    // image when history is re-converted for a model that no longer has vision.
    if (finalTools.read_page) {
      finalTools = {
        ...finalTools,
        read_page: guardReadPageToolForVision(finalTools.read_page, hasVisionCapability(providerResult.modelName)),
      };
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
      inferenceMessages = [...await Promise.all(dbMessages.map(convertDbMessageToUIMessage)), userMessage];
    }

    // Back-fill: when the client manages full history, persist tool results that arrived
    // in role:tool messages (normalizeMessages collapsed them into assistant UIMessage parts).
    // We cannot use msg.id — pagespace-cli sends OpenAI-format messages without id fields, so
    // normalizeMessages assigns a random createId(). Instead we match DB assistant rows by
    // tool_call_id, which is a stable key present in both the request body and the DB toolCalls.
    if (clientManagesHistory && isThreadMode) {
      const resultsByCallId = new Map<string, ReturnType<typeof extractToolResults>[number]>();
      for (const msg of messages.slice(0, -1)) {
        if (msg.role !== 'assistant') continue;
        for (const result of extractToolResults(msg)) {
          resultsByCallId.set(result.toolCallId, result);
        }
      }
      if (resultsByCallId.size > 0) {
        // Fire-and-forget — the response does not wait for back-fill to complete.
        // Best-effort: a failure is logged but does not affect the streaming reply.
        chatMessageRepository.getMessagesByConversationId(conversationId)
          .then(dbRows => {
            for (const row of dbRows) {
              if (row.role !== 'assistant' || !row.isActive) continue;
              const rawArr: unknown[] = Array.isArray(row.toolCalls)
                ? row.toolCalls
                : (() => {
                    try { const p = JSON.parse(row.toolCalls as string); return Array.isArray(p) ? p : []; }
                    catch { return []; }
                  })();
              const matched = rawArr
                .filter((tc): tc is Record<string, unknown> =>
                  typeof tc === 'object' && tc !== null &&
                  typeof (tc as Record<string, unknown>).toolCallId === 'string' &&
                  resultsByCallId.has((tc as Record<string, unknown>).toolCallId as string)
                )
                .map(tc => resultsByCallId.get(tc.toolCallId as string)!);
              if (matched.length > 0) {
                chatMessageRepository.updateMessageToolResults(row.id, conversationId, matched)
                  .catch((err: unknown) => loggers.ai.error('OpenAI API: failed to back-fill tool results', err as Error));
              }
            }
          })
          .catch((err: unknown) => loggers.ai.error('OpenAI API: failed to load rows for tool-result back-fill', err as Error));
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

    // Sliding-window compaction: only active for thread-mode calls where we own history.
    // Non-admin users, client-manages-history, and non-thread-mode all get exact legacy behavior.
    let compactedModelMessages: ModelMessage[] = await convertToModelMessages(sanitized);
    let v1ScheduleCompaction: () => void = () => undefined;
    if (isThreadMode && !clientManagesHistory) {
      const prepared = await prepareHistoryForModel({
        history: sanitized,
        conversationId,
        source: 'page',
        pageId,
        model: providerResult.modelName,
        provider: providerResult.provider,
        systemPrompt: systemPrompt + (callerSystemPrompt ? `\n\n${callerSystemPrompt}` : '') + toolDiscoveryPrompt,
        tools: finalTools as Record<string, unknown>,
        user: { id: authResult.userId, role: gateUser?.role ?? null },
      });
      v1ScheduleCompaction = prepared.scheduleCompaction;
      ({ modelMessages: compactedModelMessages } = await finishModelRequest({ prepared, tools: finalTools }));
    }

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
    // spend, so we bill them and release the gate's hold in the same path. A mid-stream error
    // passes errored:true so the burned tokens are billed as a failure (success:false) — like
    // ai/chat's error-path trackUsage — instead of being released and lost (L7).
    let settled = false;
    let assistantText = '';
    const settle = async ({ aborted, errored = false, text, totalUsage, steps }: {
      aborted: boolean;
      errored?: boolean;
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
          ...(page?.driveId && isConversationShared && {
            mentionNotify: {
              driveId: page.driveId,
              triggeredByUserId: authResult.userId,
              mentionerName: page.title ?? undefined,
            },
          }),
        }).catch((err: unknown) => {
          loggers.ai.error('OpenAI API: failed to save assistant message', err as Error);
        });
      }

      // trackUsage -> consumeCredits decrements the balance and deletes the hold in one
      // transaction (idempotent if the hold is already gone). success:false on abort/error
      // still bills burned tokens while marking the run unsuccessful.
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
        success: !aborted && !errored,
        holdId,
        metadata: { via: 'openai_api_v1', ...(aborted ? { aborted: true } : {}), ...(errored ? { errored: true } : {}) },
      }).catch((err: unknown) => {
        loggers.ai.error('OpenAI API: failed to track usage', err as Error);
      });
    };

    const aiResult = streamText({
      model: providerResult.model,
      system: systemPrompt + (callerSystemPrompt ? `\n\n${callerSystemPrompt}` : '') + toolDiscoveryPrompt,
      messages: compactedModelMessages,
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
        // Bind tool execution to the MCP token's drive scope and RBAC role so a
        // scoped token cannot reach drives outside its scope — or exceed its own
        // membership role — via the agent's broader ACL.
        mcpAllowedDriveIds: getAllowedDriveIds(authResult),
        mcpTokenId: isMCPAuthResult(authResult) ? authResult.tokenId : undefined,
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
          const totalUsage = await Promise.resolve(aiResult.totalUsage).catch(() => undefined);
          const steps = await Promise.resolve(aiResult.steps).catch(() => undefined);
          await settle({ aborted, text: assistantText || undefined, totalUsage, steps });
          if (!aborted) v1ScheduleCompaction();
          if (!aborted) {
            const toolSummary = buildToolSummaryEvent(steps ?? []);
            if (toolSummary) {
              controller.enqueue(encoder.encode(toolSummary + '\n\n'));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          }
          controller.close();
        } catch (err) {
          const aborted = abortController.signal.aborted;
          // Gather whatever partial usage/spend the stream produced before failing.
          // totalUsage/steps reject if the stream never produced them — treat that as
          // "nothing burned".
          const totalUsage = await Promise.resolve(aiResult.totalUsage).catch(() => undefined);
          const steps = await Promise.resolve(aiResult.steps).catch(() => undefined);

          if (aborted) {
            // Some providers surface an abort as a thrown AbortError instead of ending the
            // stream gracefully. Treat it as a clean stop: settle the partial usage the same
            // way the normal finish path does (resolveHoldDisposition would return 'handed-off'
            // for an aborted streaming phase).
            loggers.ai.info('OpenAI API: stream aborted by consumer', { pageId, conversationId });
            await settle({ aborted: true, text: assistantText || undefined, totalUsage, steps });
            controller.close();
            return;
          }

          // "Billable usage" is strictly real token counts. For a FAILED run, trackUsage only
          // reaches consumeCredits when totalTokens > 0 (ai-monitoring.ts:942) and otherwise
          // just releases the hold. So streamed text or provider cost WITHOUT token counts
          // would settle a misleading $0 row and release anyway — no better than a plain
          // release, but noisier. We therefore only settle-partial when tokens were actually
          // captured; with none, we release the hold directly (Codex P1).
          const hasUsage = !!(totalUsage && (
            (totalUsage.inputTokens ?? 0) > 0 ||
            (totalUsage.outputTokens ?? 0) > 0 ||
            (totalUsage.cachedInputTokens ?? 0) > 0 ||
            (totalUsage.reasoningTokens ?? 0) > 0
          ));
          const disposition = resolveHoldDisposition({ phase: 'streaming', aborted: false, usage: hasUsage });

          loggers.ai.error('OpenAI API: stream failed', err as Error);
          if (disposition === 'settle-partial') {
            // Mid-stream error with real spend: bill the burned tokens best-effort as a failed
            // run (success:false) BEFORE the hold is gone, so reconcile/backfill has the real
            // spend to recover. settle() consumes the hold in the same transaction (L7).
            await settle({ aborted: false, errored: true, text: assistantText || undefined, totalUsage, steps });
          } else if (!settled && holdId) {
            // Nothing was burned: just free the reservation so it doesn't linger to TTL.
            // Idempotent if settlement already happened.
            await releaseHold(holdId).catch(() => {});
          }
          controller.error(err);
        }
      },
      cancel() {
        // Consumer closed the connection mid-stream: stop the model.
        abortController.abort();
      },
    });

    // The streaming lifecycle (settle / the stream's error handler) now owns the hold, so the
    // setup finally below must not release it.
    holdHandedOff = true;
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (setupError) {
    // Pre-stream failure (capabilities / convertToModelMessages / persistence). No provider
    // tokens were billed; the finally frees the hold. Return 500 like the in-app chat route.
    loggers.ai.error('OpenAI API: request setup failed before streaming', setupError as Error, { pageId });
    return NextResponse.json({ error: 'Failed to process chat request. Please try again.' }, { status: 500 });
  } finally {
    // Setup-phase disposition is always 'release' (resolveHoldDisposition); only act when the
    // stream never took ownership of the hold. AWAIT the release here: this path returns a
    // plain JSON 500 with no stream to keep the runtime alive, so a fire-and-forget release
    // could be abandoned if a serverless runtime freezes after the response — the exact leak
    // this change closes (Codex P2). Idempotent and best-effort.
    if (holdId && !holdHandedOff && resolveHoldDisposition({ phase: 'setup', aborted: false, usage: false }) === 'release') {
      await releaseHold(holdId).catch(() => {});
    }
  }
}
