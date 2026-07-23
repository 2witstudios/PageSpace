import { NextResponse } from 'next/server';
import {
  streamText,
  UIMessage,
  stepCountIs,
  hasToolCall,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type TextUIPart,
  type ToolSet,
} from 'ai';
import { ONPREM_ALLOWED_PROVIDERS, DEFAULT_PROVIDER, DEFAULT_MODEL, resolveProviderModel } from '@/lib/ai/core/ai-providers-config';
import { resolveGenerationAdmission } from '@/lib/ai/core/generation-admission';
import { ALL_PROVIDER_NAMES } from '@/lib/ai/core/ai-utils';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { mergeToolSets } from '@/lib/ai/core/tool-utils';
import { finishTool, FINISH_TOOL_NAME } from '@/lib/ai/tools/finish-tool';
import { askUserTools, ASK_USER_TOOL_NAME } from '@/lib/ai/tools/ask-user-tools';
import { canUseAskUser } from '@/lib/ai/core/ask-user-gating';
import {
  extractClientAskUserResults,
  applyAskUserResultsToPageMessage,
  dismissPendingAskUserForPageConversation,
} from '@/lib/ai/core/ask-user-resume';
import { requiresProSubscription } from '@/lib/subscription/rate-limit-middleware';
import { MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { isMeteringExempt } from '@pagespace/lib/ai/model-defaults';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { makeOnStepFinishHandler } from './step-finish-handler';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { creditGateErrorResponse } from '@/lib/subscription/credit-gate-response';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { broadcastChatUserMessage } from '@/lib/websocket';
import { createStreamLifecycle, type StreamLifecycleHandle } from '@/lib/ai/core/stream-lifecycle';
import { takeOverConversationStreams } from '@/lib/ai/core/stream-takeover';
import { startGenerationExclusive } from '@/lib/ai/core/start-generation-exclusive';
import { chunkToPart } from '@/lib/ai/streams/chunkToPart';
import { resolveMessageId } from '@/lib/ai/streams/resolveMessageId';
import { validateBrowserSessionIdHeader } from '@/lib/ai/core/browser-session-id-validation';
import { authenticateRequestWithOptions, isAuthError, isMCPAuthResult, checkMCPPageScope, getAllowedDriveIds, isScopedMCPAuth, canPrincipalViewPage, canPrincipalEditPage } from '@/lib/auth';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };
// canUserViewPage stays user-level here: it gates mention-notification RECIPIENTS
// (other users), not the requesting principal.
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { createAIProvider, updateUserProviderSettings, createProviderErrorResponse, isProviderError, type ProviderRequest } from '@/lib/ai/core/provider-factory';
import { buildProviderAvailabilityMap } from '@/lib/ai/core/ai-utils';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import { extractMessageContent, extractToolCalls, extractToolResults, saveMessageToDatabase, sanitizeMessagesForModel, convertDbMessageToUIMessage } from '@/lib/ai/core/message-utils';
import { buildAssistantPersistencePayload } from '@/lib/ai/core/persistAssistantParts';
import { processMentionsInMessage, buildMentionSystemPrompt } from '@/lib/ai/core/mention-processor';
import {
  buildCommandPromptSection,
  commandExecutionDataFromPlan,
  COMMAND_EXECUTION_PART_TYPE,
  type CommandExecutionPlan,
} from '@/lib/ai/core/command-processor';
import { planCommandExecutions } from '@/lib/ai/core/command-resolver';
import { buildTimestampSystemPrompt } from '@/lib/ai/core/timestamp-utils';
import { buildSystemPrompt, buildPersonalizationPrompt } from '@/lib/ai/core/system-prompt';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { getAgentContextDrives } from '@pagespace/lib/services/drive-agent-service';
import { buildInlineInstructions } from '@/lib/ai/core/inline-instructions';
import { buildLocationTurnPrompt } from '@/lib/ai/core/location-prompt';
import {
  filterToolsForReadOnly,
  filterToolsForMcpScope,
  filterToolsForMachineBinding,
  filterToolsForAgentAllowlist,
  withSessionFamilyTools,
} from '@/lib/ai/core/tool-filtering';
import { deriveMachinePaneBinding } from '@pagespace/lib/services/machines/machine-pane-binding';
import { buildMachinePaneBindingDeps } from '@/lib/ai/machine-pane/machine-pane-binding-runtime';
import { shouldExposeImageGen } from '@/lib/ai/core/image-gen-access';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/core/model-capabilities';
import { getPageTreeContext } from '@/lib/ai/core/page-tree-context';
import { getModelCapabilities } from '@/lib/ai/core/model-capabilities';
import { guardReadPageToolForVision } from '@/lib/ai/tools/read-page-vision-output';
import { convertMCPToolsToAISDKSchemas, parseMCPToolName, sanitizeToolNamesForProvider } from '@/lib/ai/core/mcp-tool-converter';
import { getUserPersonalization } from '@/lib/ai/core/personalization-utils';
import { applyToolExposureMode } from '@/lib/ai/tools/tool-exposure';
import {
  buildVolatileTurnContext,
  appendTurnContextToLastUserMessage,
  withCacheBreakpoints,
} from '@/lib/ai/core/prompt-assembly';
import { prepareHistoryForModel, finishModelRequest } from '@/lib/ai/core/context-assembly';
import { getAgentMemoryContext, buildAgentMemorySection } from '@/lib/ai/core/agent-memory';

// Runtime-toggled tools that must stay directly callable even in search mode.
// Runtime-override tools: added independently of the agent's saved allowlist, so they
// must stay directly callable in 'search' exposure mode — routing them through
// execute_tool would hit that tool's allowlist check and be rejected.
const ALWAYS_UPFRONT_TOOLS = new Set(['web_search', 'generate_image']);
import { db } from '@pagespace/db/db'
import { eq, and, ne } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { chatMessages, pages, drives } from '@pagespace/db/schema/core';
import { userProfiles } from '@pagespace/db/schema/members';
import { createId, isCuid } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskIdentifier } from '@/lib/logging/mask';
import { trackFeature } from '@pagespace/lib/monitoring/activity-tracker';
import { AIMonitoring, extractOpenRouterCostDollars, extractOpenRouterGenerationIds } from '@pagespace/lib/monitoring/ai-monitoring';
import type { MCPTool } from '@/types/mcp';
import { getMCPBridge } from '@/lib/mcp';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';
import { expandMentionsToUserIds } from '@/lib/channels/expand-group-mentions';
import { createMentionNotification } from '@pagespace/lib/notifications/notifications';
import {
  attachStreamFinisher,
  createStreamAbortController,
  removeStream,
  STREAM_ID_HEADER,
} from '@/lib/ai/core/stream-abort-registry';
import { runAgentWithRetry, AGENT_MAX_STEPS, isRunAborted, type RunAgentWithRetryResult } from '@/lib/ai/core/run-agent-with-retry';
import { resolveRequestContext } from '@/lib/ai/core/resolve-request-context';
import { locationContextToPageContext } from '@/lib/ai/shared/buildPageContext';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import { validateUserMessageFileParts, hasFileParts } from '@/lib/ai/core/validate-image-parts';
import { hasVisionCapability } from '@/lib/ai/core/model-capabilities';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { buildMachineBindingPrompt } from '@/lib/ai/machines/machine-binding-prompt';


// Allow streaming responses up to 5 minutes for complex AI agent interactions
export const maxDuration = 300;

export async function POST(request: Request) {
  const startTime = Date.now();
  let userId: string | undefined;
  let chatId: string | undefined;
  let conversationId: string | undefined;
  let isConversationShared = false;
  let selectedProvider: string | undefined;
  let selectedModel: string | undefined;
  // Outcome of the retry shell, shared from execute() to onFinish(). Carries the
  // summed usage/steps for billing plus the success flag, abort detection, and retry
  // observability — so no separate usage/steps promises are needed.
  let agentRun: RunAgentWithRetryResult | undefined;
  // Hoisted to outer scope so the catch-path trackUsage call bills on the real
  // backend model id rather than the client-supplied alias (selectedModel).
  let resolvedModelName: string | undefined;
  // The provider that ACTUALLY ran, post catalog-substitution (factory's resolution).
  // Billing settles on this — not the raw requested provider — so the metering
  // exemption at settle agrees with the credit gate (both key on the resolved
  // provider). A `glm` + invalid-model request resolves to the metered default, so
  // it must bill, not be exempted.
  let resolvedProvider: string | undefined;
  let lifecycle: StreamLifecycleHandle | undefined;
  let activeStreamId: string | undefined;
  let serverAssistantMessageId: string | undefined;
  // Set once the assistant placeholder row has received a terminal write (execute-end or
  // onFinish). The outer catch's best-effort cleanup below must not fire once this is true —
  // it would otherwise downgrade an already-'complete' row to 'interrupted' if something threw
  // AFTER a successful persist but before the response was returned. See Server Stream
  // Durability epic PR 2 — Codex review: a stream stopped before any content (or before
  // createUIMessageStream even finishes constructing) must not leave the placeholder stuck at
  // 'streaming' forever (excluded from reads, 409s on edit/delete).
  let assistantMessagePersisted = false;
  // Mention-notification context + once-flag shared by the THREE writes that can flip the
  // assistant placeholder out of 'streaming' (execute-end, onFinish, the outer-catch cleanup).
  // Whichever terminal write lands FIRST carries `mentionNotify` into saveMessageToDatabase;
  // the flag (latched only after a SUCCESSFUL save, so a failed execute-end persist still lets
  // onFinish notify) suppresses the later writes — one request never notifies the same
  // @mention twice. Hoisted out of the try (unlike `page`) because the outer-catch cleanup
  // needs it too. materialize-interrupted-stream.ts's CAS-gated notify RELIES on this contract:
  // it only notifies rows it flips out of 'streaming' itself, on the premise that any row the
  // route flipped was already notified by the route (Codex P2, PR #2097).
  let mentionPage: { driveId: string; title: string } | undefined;
  let mentionNotified = false;
  const mentionNotifyFor = (
    content: string,
  ): { driveId: string; triggeredByUserId: string; mentionerName: string } | undefined => {
    // Mirrors the gate the onFinish save historically applied (page.driveId present, a
    // triggering user, conversation explicitly shared) plus saveMessageToDatabase's own
    // content.trim() firing condition — so the flag can only latch when a notification
    // would actually have been dispatched.
    if (mentionNotified || !mentionPage || !userId || !isConversationShared || !content.trim()) {
      return undefined;
    }
    return { driveId: mentionPage.driveId, triggeredByUserId: userId, mentionerName: mentionPage.title };
  };
  // The gate + attach + latch protocol in ONE place, so a terminal-write site can't get one of
  // the three steps wrong (e.g. latching before the save resolves, which would eat the mention
  // when the save then fails). Callers keep their own try/catch and assistantMessagePersisted
  // handling — this owns only the exactly-once mention contract.
  //
  // Best-effort exactly-once, named honestly: the latch flips only AFTER the save resolves
  // (deliberately — latching before it would lose the mention when the save fails), so two
  // terminal writers overlapping in flight (the outer-catch cleanup racing a still-running
  // execute-end) can each pass the gate before either latches, and a stalled-but-alive stream
  // reaped by another instance's materializer can be re-notified by this process's own later
  // save. Both windows resolve to a DUPLICATE ping, never a lost one — the epic's chosen
  // direction. The durable fix (idempotent createMentionNotification per user+message) is a
  // filed epic D task.
  const saveTerminalAssistantMessage = async (
    args: Omit<Parameters<typeof saveMessageToDatabase>[0], 'mentionNotify'>,
  ): Promise<void> => {
    const mentionNotify = mentionNotifyFor(args.content);
    await saveMessageToDatabase({ ...args, ...(mentionNotify && { mentionNotify }) });
    if (mentionNotify) mentionNotified = true;
  };
  // Captured by the inner catch (createUIMessageStream construction failure) BEFORE it calls
  // lifecycle.finish() — finish() deletes the multicast registry entry getBufferedParts() reads
  // from, so by the time the outer catch below runs, a fresh getBufferedParts() call would
  // always see an empty buffer. Falls back to a fresh (empty) capture in the outer catch when
  // this was never set (i.e. the throw happened somewhere else, before finish() ever ran).
  let bufferedPartsAtStreamError: ReturnType<StreamLifecycleHandle['getBufferedParts']> | undefined;
  // The credit-gate reservation for this request, released when usage is billed.
  let holdId: string | undefined;
  // True once the stream/error handler owns the hold's release. Any earlier
  // return/throw must release the hold (a pre-generation exit doesn't invoke the
  // model, so the reservation would otherwise sit until the reconcile cron sweeps it).
  let holdHandedOff = false;
  const permissionLogger = loggers.ai.child({ module: 'page-ai-permissions' });

  try {
    loggers.ai.info('AI Chat API: Starting request processing');

    const browserSessionIdResult = validateBrowserSessionIdHeader(request.headers.get('X-Browser-Session-Id'));
    if (!browserSessionIdResult.ok) {
      return NextResponse.json({ error: browserSessionIdResult.message }, { status: browserSessionIdResult.status });
    }
    const browserSessionId = browserSessionIdResult.browserSessionId;

    // Authenticate the request
    const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(authResult)) {
      loggers.ai.warn('AI Chat API: Authentication failed');
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_chat', resourceId: 'post', details: { reason: 'auth_failed', method: 'POST', authFailureReason: authResult.authFailureReason }, riskScore: 0.5 });
      return authResult.error;
    }
    userId = authResult.userId;
    loggers.ai.debug('AI Chat API: Authentication successful', { userId });

    // Body size guard — reject payloads over 25MB before parsing
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > 25 * 1024 * 1024) {
      loggers.ai.warn('AI Chat API: Request body too large', { contentLength });
      return NextResponse.json({ error: 'Request body too large (max 25MB)' }, { status: 413 });
    }

    // Parse request body for AI SDK v5 pattern
    const requestBody = await request.json();
    loggers.ai.debug('AI Chat API: Request body received', {
      messageCount: requestBody.messages?.length || 0,
      chatId: requestBody.chatId,
      selectedProvider: requestBody.selectedProvider,
      selectedModel: requestBody.selectedModel,
    });
    
    const {
      messages, // Used ONLY to extract new user message, NOT for conversation history
      chatId: requestChatId, // chat ID (page ID) - standard AI SDK pattern
      conversationId: requestConversationId, // Conversation session ID (auto-generated if not provided)
      selectedProvider: requestSelectedProvider,
      selectedModel: requestSelectedModel,
      pageContext: legacyPageContext, // Deprecated: server-resolved from contextRef when present, kept 1+ release for old clients
      contextRef,
      mcpTools, // MCP tool schemas from desktop client (optional)
      isReadOnly, // Optional read-only mode toggle
      webSearchEnabled, // Optional web search toggle (defaults to false)
      imageGenEnabled, // Optional image-generation toggle (defaults to false)
    }: {
      messages: UIMessage[],
      chatId?: string,
      conversationId?: string, // Optional - will be auto-generated if not provided
      selectedProvider?: string,
      selectedModel?: string,
      mcpTools?: MCPTool[], // MCP tool schemas from desktop (client-side execution)
      isReadOnly?: boolean, // Optional read-only mode toggle
      webSearchEnabled?: boolean, // Optional web search toggle (defaults to false)
      imageGenEnabled?: boolean, // Optional image-generation toggle (defaults to false)
      contextRef?: ContextRef,
      pageContext?: {
        pageId: string,
        pageTitle: string,
        pageType: string,
        pagePath: string,
        parentPath: string,
        breadcrumbs: string[],
        driveId?: string,
        driveName: string,
        driveSlug: string,
      }
    } = requestBody;

    // Assign to outer scope variables for error handling
    chatId = requestChatId;
    selectedProvider = requestSelectedProvider;
    selectedModel = requestSelectedModel;

    // For Page AI, we'll use custom agent configuration instead of fixed roles
    // Global assistant will continue to use the role system
    loggers.ai.debug('AI Page Chat API: Page AI using custom agent configuration');

    // Validate required parameters
    if (!messages || messages.length === 0) {
      loggers.ai.warn('AI Chat API: No messages provided');
      return NextResponse.json({ error: 'messages are required' }, { status: 400 });
    }

    if (!chatId) {
      loggers.ai.warn('AI Chat API: No chatId provided');
      return NextResponse.json({ error: 'chatId is required' }, { status: 400 });
    }

    // Server-resolved (and permission-checked) from contextRef when the client sent
    // one — a contextRef pointing at a page/drive the caller cannot view resolves to
    // undefined here rather than trusting whatever the client claimed. Falls back to
    // the legacy client-computed pageContext only for old clients that never sent a
    // contextRef at all. Deferred until after the required-field checks above so an
    // invalid request (no messages/chatId) fails fast without an extra DB round-trip.
    const pageContext = contextRef
      ? locationContextToPageContext(await resolveRequestContext(authResult, contextRef, (denied) => {
          auditRequest(request, {
            eventType: 'authz.access.denied',
            userId,
            resourceType: denied.routeType === 'drive' ? 'drive' : 'page',
            resourceId: denied.routeType === 'drive' ? denied.driveId : denied.pageId,
            details: { reason: 'context_ref_denied', method: 'POST', chatId },
            riskScore: 0.3,
          });
        }))
      : legacyPageContext;

    const mcpScopeError = await checkMCPPageScope(authResult, chatId);
    if (mcpScopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_chat', resourceId: chatId, details: { reason: 'mcp_page_scope_denied', method: 'POST' }, riskScore: 0.5 });
      return mcpScopeError;
    }

    // Ensure userId and chatId are defined
    if (!userId) {
      loggers.ai.warn('AI Chat API: No userId after authentication');
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
    }

    // Image security validation — validate file parts in the user message
    const userMessageForValidation = messages[messages.length - 1];
    const messageHasImages = userMessageForValidation?.role === 'user' && hasFileParts(userMessageForValidation);
    if (messageHasImages) {
      const imageValidation = validateUserMessageFileParts(userMessageForValidation);
      if (!imageValidation.valid) {
        loggers.ai.warn('AI Chat API: Image validation failed', { error: imageValidation.error });
        return NextResponse.json({ error: imageValidation.error }, { status: 400 });
      }
    }

    // Check if user has permission to view and edit this AI chat page
    const maskedUserId = maskIdentifier(userId);
    const maskedChatId = maskIdentifier(chatId);
    permissionLogger.debug('Evaluating Page AI permissions', {
      userId: maskedUserId,
      chatId: maskedChatId,
    });
    const canView = await canPrincipalViewPage(authResult, chatId);
    permissionLogger.debug('Page AI view permission evaluated', {
      userId: maskedUserId,
      chatId: maskedChatId,
      allowed: canView,
    });
    if (!canView) {
      loggers.ai.warn('AI Chat API: User lacks view permission', { userId: maskedUserId, chatId: maskedChatId });
      permissionLogger.warn('Page AI view permission denied', {
        userId: maskedUserId,
        chatId: maskedChatId,
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_chat', resourceId: chatId, details: { reason: 'no_view_permission', method: 'POST' }, riskScore: 0.5 });
      return NextResponse.json({ error: 'You do not have permission to view this AI chat' }, { status: 403 });
    }

    const canEdit = await canPrincipalEditPage(authResult, chatId);
    permissionLogger.debug('Page AI edit permission evaluated', {
      userId: maskedUserId,
      chatId: maskedChatId,
      allowed: canEdit,
    });
    if (!canEdit) {
      loggers.ai.warn('AI Chat API: User lacks edit permission', { userId: maskedUserId, chatId: maskedChatId });
      permissionLogger.warn('Page AI edit permission denied', {
        userId: maskedUserId,
        chatId: maskedChatId,
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_chat', resourceId: chatId, details: { reason: 'no_edit_permission', method: 'POST' }, riskScore: 0.5 });
      return NextResponse.json({ error: 'You do not have permission to send messages in this AI chat' }, { status: 403 });
    }

    permissionLogger.info('Page AI permissions granted', {
      userId: maskedUserId,
      chatId: maskedChatId,
    });
    
    loggers.ai.info('AI Chat API: Validation passed', { 
      messageCount: messages.length, 
      chatId 
    });

    // Get page configuration for custom agent settings (needed early for message saving)
    const [page] = await db.select().from(pages).where(eq(pages.id, chatId));
    if (!page) {
      loggers.ai.warn('AI Chat API: Page not found', { chatId });
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }
    // pages.driveId is NOT NULL in the schema, so this is unconditional; mentionNotifyFor's
    // !mentionPage guard covers only the outer-catch running before this line executes.
    mentionPage = { driveId: page.driveId, title: page.title };

    // Vision capability gate — reject images sent to non-vision models
    if (messageHasImages) {
      const effectiveModel = selectedModel || page.aiModel;
      if (effectiveModel && !hasVisionCapability(effectiveModel)) {
        loggers.ai.warn('AI Chat API: Images sent to non-vision model', { model: effectiveModel });
        return NextResponse.json(
          { error: `The selected model "${effectiveModel}" does not support image attachments. Please choose a vision-capable model.` },
          { status: 400 }
        );
      }
    }

    // Extract custom agent configuration from page.
    // page.enabledTools seeds the composer's tool toggles on the client and is
    // enforced server-side (see agentEnabledTools filter below).
    // Request-body toggles (isReadOnly, webSearchEnabled) are applied independently:
    // isReadOnly filters the baseline; webSearchEnabled overrides the allowlist.
    const customSystemPrompt = page.systemPrompt;

    // Fetch drive prompt if page has includeDrivePrompt enabled
    let drivePromptPrefix = '';
    if (page.includeDrivePrompt) {
      try {
        const [drive] = await db
          .select({ drivePrompt: drives.drivePrompt })
          .from(drives)
          .where(eq(drives.id, page.driveId))
          .limit(1);

        if (drive?.drivePrompt?.trim()) {
          drivePromptPrefix = `## DRIVE INSTRUCTIONS\n\n${drive.drivePrompt}\n\n---\n\n`;
          loggers.ai.debug('AI Page Chat API: Including drive prompt', {
            driveId: page.driveId,
            promptLength: drive.drivePrompt.length
          });
        }
      } catch (error) {
        loggers.ai.error('AI Page Chat API: Failed to fetch drive prompt', error as Error);
        // Continue without drive prompt on error
      }
    }

    // Fetch context from any other drives this agent is a member of with
    // includeContext enabled (excludes the home drive, covered above).
    // Filtered to the caller's MCP drive scope so a token scoped to only the
    // agent's home drive can't pull another member drive's prompt through
    // this path (the tool layer enforces the same ceiling for actor-driven
    // reads; this is the equivalent for a value the route reads directly).
    let memberDriveContextPrefix = '';
    try {
      const allowedDriveIds = getAllowedDriveIds(authResult);
      const allContextDrives = await getAgentContextDrives(chatId);
      const contextDrives = allowedDriveIds.length > 0
        ? allContextDrives.filter((d) => allowedDriveIds.includes(d.driveId))
        : allContextDrives;
      if (contextDrives.length > 0) {
        memberDriveContextPrefix = contextDrives
          .map((d) => `## DRIVE CONTEXT: ${d.driveName}\n\n${d.drivePrompt}\n\n---\n\n`)
          .join('');
        loggers.ai.debug('AI Page Chat API: Including member-drive context', {
          driveCount: contextDrives.length,
        });
      }
    } catch (error) {
      loggers.ai.error('AI Page Chat API: Failed to fetch member-drive context', error as Error);
      // Continue without member-drive context on error
    }

    loggers.ai.debug('AI Page Chat API: Using custom agent configuration', {
      hasCustomSystemPrompt: !!customSystemPrompt,
      pageName: page.title,
      includeDrivePrompt: page.includeDrivePrompt,
      hasDrivePrompt: !!drivePromptPrefix
    });

    // conversationId is caller-supplied, and the history load below is keyed on
    // (pageId, conversationId) with NO user filter — so an id that resolves to
    // someone else's conversation reads their private history into the model context
    // and appends this user's message to it. Two rules, both enforced here:
    //
    //  1. A conversation may only ever be CREATED from a cuid. The client used to
    //     send a `${pageId}-default` sentinel for a brand-new chat and this route
    //     accepted it unvalidated, minting a real conversations row under it — which
    //     the client then refused to load, stranding the history. Those rows exist in
    //     production and the client now loads and keeps using them, so a bare isCuid
    //     reject would lock those users out of the history we just gave them back.
    //     Hence: a non-cuid id is accepted only if its row ALREADY exists.
    //
    //  2. An EXISTING conversation must be one this user may actually write to —
    //     their own, or an explicitly shared one — and must belong to this page.
    //     Without this, `${pageId}-default` is a guessable id (it is derived from the
    //     page id) that any member with edit access could use to read a co-member's
    //     private conversation. Conversations are private by default.
    let existingConversation: Awaited<ReturnType<typeof conversationRepository.getConversation>> = null;
    if (requestConversationId) {
      // Deliberately un-caught. A DB error here must not degrade into "no row exists",
      // which is the branch that lets a fresh cuid through — an authorization check that
      // fails open on a blip is not a check. A throw lands in the route's 500 handler.
      existingConversation = await conversationRepository.getConversation(requestConversationId);

      if (!existingConversation) {
        if (!isCuid(requestConversationId)) {
          loggers.ai.warn('AI Chat API: rejected non-cuid conversationId with no existing row', {
            userId,
            requestConversationId,
          });
          return NextResponse.json({ error: 'Invalid conversationId' }, { status: 400 });
        }
        // No `conversations` row does NOT prove the conversation is new. A LEGACY
        // conversation (messages written before the conversations table was populated)
        // has messages under its id and no row — and the ownership check below would be
        // skipped for it entirely, so a caller supplying someone else's legacy cuid would
        // read that history into their model context, append to it, and now (since
        // takeover aborts as the stream's owner) be able to abort its stream too. Fail
        // closed on the same signal `createConversation` uses for the row itself.
        // No `.catch(() => false)` here: this is an authorization check, and swallowing a
        // DB error into "no conflict" would fail OPEN on exactly the blip an attacker
        // would like to cause. A throw here lands in the route's 500 handler.
        const hasConflictingOwner = await conversationRepository
          .hasConflictingMessageOwner(requestConversationId, userId!);
        if (hasConflictingOwner) {
          loggers.ai.warn('AI Chat API: rejected legacy conversationId owned by another user', {
            userId,
            requestConversationId,
          });
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
      } else {
        const ownsIt = existingConversation.userId === userId;
        const isSharedConversation = existingConversation.isShared === true;
        // contextId is nullable in the schema (null for global conversations), so only
        // enforce the page match when it is actually set — an owner must never be
        // locked out of their own row by a historically-unset column.
        const belongsToThisPage =
          !existingConversation.contextId || existingConversation.contextId === chatId;
        if ((!ownsIt && !isSharedConversation) || !belongsToThisPage) {
          loggers.ai.warn('AI Chat API: rejected conversationId the caller may not write to', {
            userId,
            requestConversationId,
            ownsIt,
            isSharedConversation,
            belongsToThisPage,
          });
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
      }
    }

    // Auto-generate conversationId if not provided (seamless UX)
    conversationId = requestConversationId || createId();
    loggers.ai.debug('AI Chat API: Conversation session', {
      conversationId,
      isNewConversation: !requestConversationId
    });

    // Machine Pane binding (Phase 5's deriveMachinePaneBinding pure core): a
    // conversation whose id is a machine_agent_terminals row bound to THIS
    // page is pinned to that machine for the rest of the request — tools,
    // system prompt, and default active machine all follow from it below.
    // No additional access check is needed here: canPrincipalViewPage /
    // canPrincipalEditPage against chatId (above) already authorizes the
    // acting user for this page, which is the precondition the pure core's
    // own docstring requires of its caller. A non-bound conversation (a
    // brand-new cuid, or any conversation not backed by a machine_agent_terminals
    // row) derives to null and leaves everything below byte-identical to today.
    const machinePaneBindingResult = await deriveMachinePaneBinding(
      { chatId: chatId!, conversationId: conversationId! },
      buildMachinePaneBindingDeps()
    );
    if (machinePaneBindingResult && !machinePaneBindingResult.ok) {
      loggers.ai.warn('AI Chat API: machine-pane binding rejected', {
        chatId: maskedChatId,
        conversationId,
        reason: machinePaneBindingResult.reason,
      });
      return NextResponse.json({ error: 'This conversation is not bound to this machine' }, { status: 400 });
    }
    // The derived handle set IS the binding: every handle already carries the
    // owning machine page id (checked against `chatId` inside the pure core),
    // so nothing is re-stamped here.
    const machineBinding = machinePaneBindingResult?.ok ? machinePaneBindingResult.binding : undefined;

    // Process @mentions in the user's message
    let mentionSystemPrompt = '';
    let mentionedPageIds: string[] = [];
    // Universal Commands: resolved execution plans for every command token
    // in the user message (zero or more). Each resolves independently and
    // degrades, never fails — a missing/forbidden command leaves the rest
    // of the request untouched.
    let commandPlans: CommandExecutionPlan[] = [];
    let commandSystemPrompt = '';

    // Load the user up front: the prepaid credit gate must run BEFORE we persist
    // the user's message OR create the conversation row. Otherwise an out-of-credits
    // request leaves an orphaned conversation/message that the client never receives
    // back and that reappears (duplicated) once the user tops up and retries.
    const [user] = await db.select().from(users).where(eq(users.id, userId));

    // Prepaid credit gate: block out-of-credits users before persisting their
    // message or invoking any model. Safe in billing-disabled deployments (returns
    // unlimited) and lazy-inits balances. On an allowed request it places a hold
    // (reservation + in-flight marker) whose id is threaded to billing and released
    // at settle; out_of_credits -> 402, the free-tier in-flight cap -> 429.
    // Metering-exempt providers (admin Z.ai Coder Plan) bill on a flat-rate external
    // subscription, so skip the credit gate entirely — no hold, no balance check —
    // and never debit at settle (see isMeteringExempt in trackAIUsage). Key the skip
    // on the RESOLVED provider (what actually runs): `glm` + an invalid model resolves
    // to the metered default, which must still be gated.
    const { provider: gateProvider } = resolveProviderModel(
      selectedProvider, selectedModel, user?.currentAiProvider, user?.currentAiModel);
    // Net spendable after all holds (including this request's) — already computed by
    // the gate so no extra DB read is needed. Each stream guards against its own slice,
    // not the gross balance, preventing concurrent streams from collectively overshooting.
    let availableBalanceCents: number | null = null;
    if (!isMeteringExempt(gateProvider)) {
      const creditGate = await canConsumeAI(userId, (user?.subscriptionTier ?? 'free') as SubscriptionTier, {
        estCostCents: estimateChatHoldCentsForModel(selectedModel),
        maxInFlight: MAX_CHAT_INFLIGHT,
      });
      if (!creditGate.allowed) {
        loggers.ai.warn('AI Chat API: AI credit gate denied', { userId, reason: creditGate.reason });
        return creditGateErrorResponse(creditGate.reason);
      }
      holdId = creditGate.holdId;
      availableBalanceCents =
        holdId && creditGate.balanceSnapshot
          ? creditGate.balanceSnapshot.netSpendableCents
          : null;
    }

    const creditAbortController = holdId ? new AbortController() : null;

    // Eagerly ensure a conversations row exists so the creator can always see
    // their own conversation. isShared defaults to false (private). Idempotent
    // via onConflictDoNothing, so safe for every message in a conversation.
    // Awaited so the row is visible to the broadcast gate below; errors are
    // swallowed (non-fatal) and the gate falls back to no-broadcast on failure.
    // Runs AFTER the credit gate so a denied first prompt leaves no orphaned row.
    await conversationRepository.createConversation(conversationId, userId!, chatId).catch(() => {});

    // Save user's message immediately to database (database-first approach)
    const userMessage = messages[messages.length - 1]; // Last message is the new user message
    // Set below (fire-early/await-late — see the ask_user branches ~30 lines down)
    // and joined right before the history load, so its DB round trip overlaps
    // with the independent setup in between instead of blocking it.
    let askUserSyncPromise: Promise<unknown> | undefined;
    if (userMessage && userMessage.role === 'user') {
      try {
        const messageId = resolveMessageId(userMessage.id);
        // Reassign so every downstream use of `userMessage` (the broadcast below,
        // any future read) agrees with what was actually persisted — resolveMessageId
        // mints a FRESH id when the client-supplied one is absent or fails the safe-id
        // shape check, and without this the object stays inconsistent: saved under
        // `messageId`, but still carrying the original (possibly rejected) id anywhere
        // `userMessage` itself is read afterward.
        userMessage.id = messageId;
        const messageContent = extractMessageContent(userMessage);

        // Process @mentions in the user message
        const processedMessage = processMentionsInMessage(messageContent);
        mentionedPageIds = processedMessage.pageIds;

        if (processedMessage.mentions.length > 0) {
          mentionSystemPrompt = buildMentionSystemPrompt(processedMessage.mentions);
          loggers.ai.info('AI Chat API: Found @mentions in user message', {
            mentionCount: processedMessage.mentions.length,
            pageIds: mentionedPageIds
          });
        }

        // Resolve every command token in the message (if any) with the
        // SENDER's permissions. The tokens stay in the saved content —
        // transcripts render each as a chip; only the system prompt gains
        // the injections.
        commandPlans = await planCommandExecutions(messageContent, userId!, {
          driveId: page.driveId,
        });
        if (commandPlans.length > 0) {
          commandSystemPrompt = buildCommandPromptSection(commandPlans);
          for (const plan of commandPlans) {
            loggers.ai.info('AI Chat API: Command resolution', {
              kind: plan.kind,
              ...(plan.kind === 'skip' ? { reason: plan.reason } : {}),
            });
          }
        }

        loggers.ai.debug('AI Chat API: Saving user message immediately', { id: messageId, contentLength: messageContent.length });

        await saveMessageToDatabase({
          messageId,
          pageId: chatId,
          conversationId,
          userId,
          role: 'user',
          content: messageContent,
          toolCalls: undefined,
          toolResults: undefined,
          uiMessage: userMessage,
        });
        
        loggers.ai.debug('AI Chat API: User message saved to database');

        auditRequest(request, { eventType: 'data.write', userId, resourceType: 'ai_chat', resourceId: chatId, details: {
          action: 'chat_message',
          conversationId,
        } });

        // Fire mention notifications for @user, @everyone, @role mentions in AI chat pages.
        // Gate each recipient on view permission to prevent leaking page metadata.
        if (page?.driveId) {
          expandMentionsToUserIds(messageContent, page.driveId)
            .then(async (notifyIds) => {
              const candidates = notifyIds.filter((id) => id !== userId);
              if (candidates.length === 0) return;
              const viewChecks = await Promise.all(
                candidates.map(async (id) => ({ id, canView: await canUserViewPage(id, chatId!) }))
              );
              await Promise.allSettled(
                viewChecks
                  .filter((e) => e.canView)
                  .map((e) =>
                    createMentionNotification(e.id, chatId!, userId!).catch((err) =>
                      loggers.ai.error('AI Chat: Failed to send mention notification', err as Error)
                    )
                  )
              );
            })
            .catch((err) => loggers.ai.error('AI Chat: Failed to expand mentions', err as Error));
        }
      } catch (error) {
        loggers.ai.error('AI Chat API: Failed to save user message', error as Error);
        return NextResponse.json({
          error: 'Failed to save message to database',
          details: error instanceof Error ? error.message : 'Unknown database error',
          userMessage: userMessage // Preserve user input for retry
        }, { status: 500 });
      }

      // A typed message was sent instead of answering a pending ask_user
      // question — dismiss it so the model doesn't re-ask. Kicked off here
      // (not awaited) and joined via askUserSyncPromise just before the
      // history load below, so its DB round trip overlaps with the
      // independent setup in between instead of blocking it — same pattern
      // as userProfilePromise a few lines down.
      askUserSyncPromise = dismissPendingAskUserForPageConversation({
        pageId: chatId as string,
        conversationId,
      }).catch((error) => {
        loggers.ai.error('AI Chat API: Failed to dismiss pending ask_user question', error as Error);
      });
    } else if (userMessage?.role === 'assistant') {
      // Resume request: the client answered a pending ask_user question via
      // addToolResult (no new user message). Merge the answer into the
      // persisted assistant row so history load below picks it up. Same
      // fire-early/await-late pattern as the dismissal branch above.
      const clientResults = extractClientAskUserResults(userMessage);
      if (clientResults.length > 0) {
        askUserSyncPromise = applyAskUserResultsToPageMessage({
          messageId: userMessage.id,
          pageId: chatId as string,
          conversationId,
          results: clientResults,
        }).catch((error) => {
          loggers.ai.error('AI Chat API: Failed to merge ask_user answer', error as Error);
        });
      }
    }

    // Get user's current AI provider settings (user was loaded above for the gate)
    const currentProvider = selectedProvider || user?.currentAiProvider || DEFAULT_PROVIDER;
    const currentModel = selectedModel || user?.currentAiModel || DEFAULT_MODEL;

    // Kick off the userProfiles displayName fetch early so it overlaps with downstream
    // setup (rate-limit checks, tool resolution, conversation load) and never blocks the
    // lifecycle handoff. Falls back to [] on failure so consumers don't have to handle rejection.
    const userProfilePromise = db
      .select({ displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1)
      .catch(() => [] as { displayName: string | null }[]);

    // Subscription gate: free users are limited to the free-model allowlist.
    const { requiresProSubscription, createSubscriptionRequiredResponse, createAdminRestrictedResponse } = await import('@/lib/subscription/rate-limit-middleware');

    const isAdminUser = user?.role === 'admin';

    // The SHARED entitlement decision (generation-admission.ts) — the same one
    // the headless dispatch path applies, so a provider restriction cannot hold
    // on one transport and evaporate on the other. This route only translates
    // the answer into its HTTP shape.
    const admission = resolveGenerationAdmission({
      provider: currentProvider,
      model: currentModel,
      subscriptionTier: user?.subscriptionTier ?? undefined,
      isAdmin: isAdminUser,
      requiresProSubscription,
    });
    if (!admission.allowed) {
      if (admission.reason === 'provider_admin_only') return createAdminRestrictedResponse();
      loggers.ai.warn('AI Chat API: paid plan required for model', {
        userId,
        provider: currentProvider,
        model: currentModel,
        subscriptionTier: user?.subscriptionTier
      });
      return createSubscriptionRequiredResponse();
    }

    // Usage tracking is handled in the onFinish callback (real OpenRouter cost).
    loggers.ai.debug('AI Chat API: will track usage in onFinish', {
      userId,
      provider: currentProvider,
      model: currentModel,
    });
    
    // Update page's AI provider/model if changed
    if (selectedProvider && selectedModel && chatId) {
      if (selectedProvider !== page.aiProvider || selectedModel !== page.aiModel) {
        try {
          const actorInfo = await getActorInfo(userId);
          await applyPageMutation({
            pageId: chatId,
            operation: 'agent_config_update',
            updates: {
              aiProvider: selectedProvider,
              aiModel: selectedModel,
            },
            updatedFields: ['aiProvider', 'aiModel'],
            expectedRevision: typeof page.revision === 'number' ? page.revision : undefined,
            context: {
              userId,
              actorEmail: actorInfo.actorEmail,
              actorDisplayName: actorInfo.actorDisplayName,
              resourceType: 'agent',
            },
          });
        } catch (error) {
          if (error instanceof PageRevisionMismatchError) {
            return NextResponse.json(
              {
                error: error.message,
                currentRevision: error.currentRevision,
                expectedRevision: error.expectedRevision,
              },
              { status: error.expectedRevision === undefined ? 428 : 409 }
            );
          }
          throw error;
        }
      }
    }


    // Create AI provider using factory service
    const providerRequest: ProviderRequest = {
      selectedProvider,
      selectedModel,
    };

    // Thread the already-loaded user row through the factory so it skips redundant DB selects.
    const providerResult = await createAIProvider(userId, providerRequest, { user: user ?? null });

    if (isProviderError(providerResult)) {
      return createProviderErrorResponse(providerResult);
    }

    // Use the resolved (provider, model) for billing. providerResult carries the
    // real backend provider/model after the factory's catalog substitution.
    const { model } = providerResult;
    resolvedModelName = providerResult.modelName;
    resolvedProvider = providerResult.provider;

    const onStepFinishForCredits =
      creditAbortController && availableBalanceCents !== null
        ? makeOnStepFinishHandler(creditAbortController, availableBalanceCents, resolvedModelName ?? 'unknown')
        : null;

    // Update user's current provider/model if changed (thread the loaded row to skip a DB select).
    await updateUserProviderSettings(userId, selectedProvider, selectedModel, { user: user ?? null });

    // Parse read-only mode (defaults to false for full access)
    const readOnlyMode = isReadOnly === true;
    // Parse web search mode (defaults to false - disabled)
    const webSearchMode = webSearchEnabled === true;
    loggers.ai.debug('AI Page Chat API: Tool modes', { isReadOnly: readOnlyMode, webSearchEnabled: webSearchMode });

    // Step 1: Apply isReadOnly filter, hide account-level-only tools
    // (e.g. create_drive) from drive-scoped MCP tokens' tool list, then drop
    // switch_machine/list_machines when this conversation is bound to one
    // machine (see machinePaneBindingResult above) and register the SESSION
    // FAMILY in their place.
    //
    // The family is added HERE, not in `pageSpaceTools`, on purpose: this is
    // the one composition site that knows about the binding, and every other
    // consumer of that registry (the global assistant, /v1 completions,
    // consult, workflows, the agent-config listings) must keep its tool set
    // byte-unchanged. The runtime module is loaded DYNAMICALLY, and only on
    // this branch: it reaches the agent-terminal and workspace stores (and,
    // through them, the Sprites driver seam), none of which an unbound
    // request has any business pulling into its module graph.
    //
    // The read-only filter is applied LAST, to the COMPOSED set (issue #2204
    // follow-up, F3). The session family is registered by ADDITION, so a filter
    // applied to the baseline alone never saw it — and add/move/kill/send all
    // mutate state, with send_session running a full agent loop in the target.
    // Filtering the final set is the only placement a later addition cannot
    // slip past.
    const baseTools = filterToolsForReadOnly(
      withSessionFamilyTools(
        filterToolsForMachineBinding(
          filterToolsForMcpScope(pageSpaceTools, isScopedMCPAuth(authResult)),
          machineBinding != null
        ),
        machineBinding != null ? (await import('@/lib/ai/tools/session-tools-runtime')).buildSessionTools() : {},
        machineBinding != null
      ),
      readOnlyMode
    );

    // Step 2: Extract web_search + generate_image so they can be handled as
    // runtime-toggle overrides independently of the per-agent allowlist.
    const {
      web_search: webSearchToolDef,
      generate_image: imageGenToolDef,
      ...baseToolsWithoutOverrides
    } = baseTools as Record<string, ToolSet[string]>;

    // Step 3: Apply per-agent PageSpace tool allowlist.
    // null/undefined = unconfigured page — no restriction (backwards compat).
    // []            = zero tools selected — block all PageSpace tools.
    // ['tool1', …]  = only those tools.
    const agentEnabledTools = page.enabledTools as string[] | null;
    let filteredTools = filterToolsForAgentAllowlist(
      baseToolsWithoutOverrides,
      agentEnabledTools
    ) as ToolSet;

    // Step 4: webSearchEnabled is a runtime input toggle that overrides the allowlist.
    // If the user toggled web search on in the composer, they get web_search regardless of enabledTools.
    if (webSearchMode && webSearchToolDef) {
      filteredTools = { ...filteredTools, web_search: webSearchToolDef };
    }

    // Step 4b: image generation is an ADMIN-ONLY runtime toggle (same override pattern as
    // web_search). Only exposed when the composer toggle is on AND the user is an app admin.
    if (
      shouldExposeImageGen({
        imageGenEnabled: imageGenEnabled === true,
        isAdmin: isAdminUser,
        hasToolDef: !!imageGenToolDef,
      }) &&
      imageGenToolDef
    ) {
      filteredTools = { ...filteredTools, generate_image: imageGenToolDef };
    }

    // Step 5: Tool exposure mode. 'upfront' (default) sends every allowed tool
    // schema directly. 'search' mirrors the Global Assistant — only core tools go
    // upfront; the rest are reached via tool_search/execute_tool. The allowlist has
    // already been applied above, so search mode can never discover a blocked tool.
    // web_search is a runtime override (added by the webSearchEnabled toggle above,
    // independent of the saved allowlist), so it must stay directly callable in
    // search mode too — routing it through execute_tool would hit that tool's
    // allowlist check and be rejected whenever the agent's saved enabledTools omit it.
    const toolExposureMode = (page.toolExposureMode as 'upfront' | 'search' | null) ?? 'upfront';
    // Capture BEFORE exposure so capability sections (TASK_MANAGEMENT, AGENTS, etc.) are
    // correctly included in search mode where non-core tools become callable via execute_tool
    // and disappear from filteredTools.
    const allowedToolNames = Object.keys(filteredTools);
    // Captured before exposure-mode transforms filteredTools below — 'search' mode
    // moves non-core tools (including all sandbox git/gh tools) behind execute_tool,
    // hiding their names from a top-level key scan. Integration-tool suppression
    // needs the pre-exposure set to correctly detect an active sandbox toolkit.
    const preExposureTools = filteredTools;
    const exposure = applyToolExposureMode(filteredTools, toolExposureMode, ALWAYS_UPFRONT_TOOLS);
    filteredTools = exposure.tools;
    const toolDiscoveryPrompt = exposure.toolDiscoveryPrompt;

    loggers.ai.debug('AI Page Chat API: Tools built from baseline + runtime toggles', {
      totalTools: Object.keys(pageSpaceTools).length,
      filteredTools: Object.keys(filteredTools).length,
      isReadOnly: readOnlyMode,
      webSearchEnabled: webSearchMode,
      toolExposureMode,
      enabledToolsAllowlist: agentEnabledTools?.length ?? 'unrestricted',
    });

    // INTEGRATION TOOLS: Resolve and merge integration tools for this agent
    try {
      const { resolvePageAgentIntegrationTools } = await import('@/lib/ai/core/integration-tool-resolver');
      const integrationTools = await resolvePageAgentIntegrationTools({
        agentId: chatId,
        userId,
        driveId: page.driveId,
        currentTools: preExposureTools,
      });
      if (Object.keys(integrationTools).length > 0) {
        filteredTools = mergeToolSets(filteredTools, integrationTools);
        loggers.ai.info('AI Chat API: Merged integration tools', {
          integrationToolCount: Object.keys(integrationTools).length,
          totalTools: Object.keys(filteredTools).length,
        });
      }
    } catch (error) {
      loggers.ai.error('AI Chat API: Failed to resolve integration tools', error as Error);
    }

    // DESKTOP MCP INTEGRATION: Merge MCP tools from client if provided
    if (mcpTools && mcpTools.length > 0) {
      try {
        loggers.ai.info('AI Chat API: Integrating MCP tools from desktop', {
          mcpToolCount: mcpTools.length,
          toolNames: mcpTools.map(t => `mcp:${t.serverName}:${t.name}`),
          userId: maskIdentifier(userId),
          chatId: maskIdentifier(chatId)
        });

        // Convert MCP tools to AI SDK format (schemas only, no execute functions)
        const mcpToolSchemas = convertMCPToolsToAISDKSchemas(mcpTools);

        // Create execute functions that signal client-side execution
        // The AI SDK will call these, but we throw a special error that the client intercepts
        // Sort keys so tool array order is deterministic across requests (only real config
        // changes — webSearch/readOnly/MCP/exposure-mode — may change the tool array).
        const mcpToolsWithExecute: Record<string, unknown> = {};
        for (const toolName of Object.keys(mcpToolSchemas).sort()) {
          const toolSchema = mcpToolSchemas[toolName];
          mcpToolsWithExecute[toolName] = {
            ...toolSchema,
            execute: async (args: Record<string, unknown>) => {
              // Ensure userId is defined (it should be from authentication)
              if (!userId) {
                throw new Error('User ID not available for MCP tool execution');
              }

              // Parse tool name using shared parser (supports both mcp:server:tool and legacy mcp__server__tool)
              const parsed = parseMCPToolName(toolName);
              if (!parsed) {
                loggers.ai.error('AI Chat API: Invalid MCP tool name format', {
                  toolName,
                  userId: maskIdentifier(userId)
                });
                throw new Error(`Invalid MCP tool name format: ${toolName}`);
              }

              const { serverName, toolName: actualToolName } = parsed;

              loggers.ai.debug('AI Chat API: Executing MCP tool via WebSocket bridge', {
                toolName: actualToolName,
                serverName,
                userId: maskIdentifier(userId),
                hasArgs: !!args
              });

              try {
                const mcpBridge = getMCPBridge();

                // Check if user is connected
                if (!mcpBridge.isUserConnected(userId)) {
                  const errorMsg = 'Desktop app not connected. Please ensure PageSpace Desktop is running.';
                  loggers.ai.warn('AI Chat API: User not connected to desktop', {
                    userId: maskIdentifier(userId),
                    toolName: actualToolName,
                    serverName
                  });
                  throw new Error(errorMsg);
                }

                // Execute tool via WebSocket bridge
                const result = await mcpBridge.executeTool(
                  userId,
                  serverName,
                  actualToolName,
                  args
                );

                loggers.ai.info('AI Chat API: MCP tool execution succeeded', {
                  toolName: actualToolName,
                  serverName,
                  userId: maskIdentifier(userId)
                });

                return result;
              } catch (error) {
                loggers.ai.error('AI Chat API: MCP tool execution failed', error as Error, {
                  toolName: actualToolName,
                  serverName,
                  userId: maskIdentifier(userId)
                });
                throw error;
              }
            }
          };
        }

        // Merge MCP tools with PageSpace tools, then sanitize for provider compatibility
        // (many providers reject colons in tool names - sanitization converts mcp:server:tool to mcp__server__tool)
        filteredTools = sanitizeToolNamesForProvider({ ...filteredTools, ...mcpToolsWithExecute } as Record<string, ToolSet[string]>) as ToolSet;

        loggers.ai.info('AI Chat API: Successfully merged MCP tools', {
          totalTools: Object.keys(filteredTools).length,
          mcpTools: Object.keys(mcpToolSchemas).length,
          pageSpaceTools: Object.keys(filteredTools).length - Object.keys(mcpToolSchemas).length
        });
      } catch (error) {
        loggers.ai.error('AI Chat API: Failed to integrate MCP tools', error as Error, {
          userId: maskIdentifier(userId),
          chatId: maskIdentifier(chatId)
        });
        // Continue without MCP tools rather than failing the entire request
      }
    } else {
      loggers.ai.debug('AI Chat API: No MCP tools provided in request', {
        userId: maskIdentifier(userId),
        chatId: maskIdentifier(chatId)
      });
    }

    // Always inject the finish tool so the model can signal task completion
    filteredTools = { ...filteredTools, ...finishTool } as ToolSet;

    // Interactive ask_user tool (execute-less, pauses the turn for user input).
    // Injected after allowlist/exposure transforms, like finish, so it is always
    // directly callable and never routed through tool_search/execute_tool.
    // allowedToolNames was captured pre-exposure; push so the inline-instructions
    // ASK_USER section is emitted.
    if (canUseAskUser(user)) {
      filteredTools = { ...filteredTools, ...askUserTools } as ToolSet;
      allowedToolNames.push(ASK_USER_TOOL_NAME);
    }

    // Guard against a stale read_page tool-result (image bytes delivered on an
    // earlier turn when the model had vision) being re-embedded as an image when
    // convertToModelMessages re-converts history for a model that no longer has
    // vision. Must run before prepareHistoryForModel/finishModelRequest below.
    if (filteredTools.read_page) {
      filteredTools = {
        ...filteredTools,
        read_page: guardReadPageToolForVision(filteredTools.read_page, hasVisionCapability(resolvedModelName ?? currentModel)),
      };
    }

    // Build system prompt BEFORE history loading so its token estimate is
    // available for prepareConversationContext's context-window budget math.

    // Fetch user personalization for AI system prompt injection
    const personalization = await getUserPersonalization(userId);
    if (personalization) {
      loggers.ai.debug('AI Chat API: User personalization loaded', {
        hasPersonalization: true,
        hasBio: !!personalization.bio,
        hasWritingStyle: !!personalization.writingStyle,
        hasRules: !!personalization.rules,
      });
    }

    // Build system prompt for Page AI - use custom system prompt if available, otherwise use default
    // Note: "current page/drive" is turn-volatile — it's built separately as
    // `locationPrompt` below and injected via buildVolatileTurnContext, NOT
    // baked in here, so this string stays byte-identical across turns.
    let systemPrompt: string;
    if (customSystemPrompt) {
      // Use custom system prompt with page context injected
      // Prepend drive prompt if enabled and available
      systemPrompt = drivePromptPrefix + customSystemPrompt;
      // Add user personalization if enabled
      const personalizationPrompt = buildPersonalizationPrompt(personalization ?? undefined);
      if (personalizationPrompt) {
        systemPrompt += `\n\n${personalizationPrompt}`;
      }
      // Add read-only constraint if applicable
      if (readOnlyMode) {
        systemPrompt += `\n\nREAD-ONLY MODE:\n• You cannot modify, create, or delete any content\n• Focus on exploring, analyzing, and planning\n• Create actionable plans for the user to execute later`;
      }
    } else {
      // Fallback to default PageSpace system prompt with read-only mode and personalization
      systemPrompt = buildSystemPrompt(
        readOnlyMode,
        personalization ?? undefined,
        isCodeExecutionEnabled()
      );

      // Append workspace knowledge (tool-aware). Custom systemPrompt = opt-out (blank slate).
      systemPrompt += buildInlineInstructions(allowedToolNames);
    }

    const locationPrompt = buildLocationTurnPrompt(pageContext ? {
      currentPage: {
        title: pageContext.pageTitle,
        type: pageContext.pageType,
        path: pageContext.pagePath,
      },
      currentDrive: pageContext.driveId ? {
        id: pageContext.driveId,
        name: pageContext.driveName,
        slug: pageContext.driveSlug,
      } : undefined,
      breadcrumbs: pageContext.breadcrumbs,
    } : undefined);

    // Cross-drive membership context applies uniformly regardless of whether
    // a custom system prompt is set (unlike drivePromptPrefix above, which is
    // only prepended in the customSystemPrompt branch).
    systemPrompt = memberDriveContextPrefix + systemPrompt;

    // Machine binding section — applies uniformly (custom or default system
    // prompt) for the same reason as memberDriveContextPrefix above. Fixed
    // for the conversation's lifetime, so it belongs in the STABLE section,
    // not the per-turn locationPrompt below.
    if (machineBinding) {
      systemPrompt += buildMachineBindingPrompt(machineBinding);
    }

    // Build timestamp system prompt for temporal awareness
    const userTimezone = user?.timezone ?? undefined;
    const timestampSystemPrompt = buildTimestampSystemPrompt(userTimezone);

    // Build page tree context if enabled
    let pageTreePrompt = '';
    if (page.includePageTree && page.driveId) {
      const pageTreeContext = await getPageTreeContext(userId, {
        scope: (page.pageTreeScope as 'children' | 'drive') || 'children',
        pageId: chatId,
        driveId: page.driveId,
      });
      if (pageTreeContext) {
        pageTreePrompt = `\n\n## WORKSPACE STRUCTURE\n\nHere is the ${page.pageTreeScope === 'drive' ? 'complete workspace' : 'page subtree'} structure:\n\n${pageTreeContext}`;
        loggers.ai.debug('AI Chat API: Page tree context included', {
          pageId: chatId,
          scope: page.pageTreeScope,
          contextLength: pageTreeContext.length
        });
      }
    }

    // Build agent memory section (AI_CHAT pages only). Fetches the "Agent Memory"
    // child page content — stable per request, only changes when the agent edits
    // the page, so it lives in the STABLE system section (not the volatile block).
    let agentMemoryPrompt = '';
    if (page.type === 'AI_CHAT') {
      const memoryContent = await getAgentMemoryContext(chatId, userId);
      agentMemoryPrompt = buildAgentMemorySection(memoryContent);
    }

    loggers.ai.debug('AI Chat API: Loading conversation history', {
      pageId: chatId
    });

    // Join the ask_user resume/dismiss write (if any) before loading history,
    // so this turn's model context reflects it — fired early above to
    // overlap with the independent setup between there and here.
    if (askUserSyncPromise) await askUserSyncPromise;

    const pageId = chatId as string;
    // Exclude 'streaming' placeholders — this load is the model-context source AND the
    // compaction source (prepareHistoryForModel below), so a placeholder here would both
    // poison this job's own turn (it hasn't finished writing yet) and risk being silently
    // summarized into a durable compaction. 'interrupted' rows stay included — they are
    // terminal, real partial output. See Server Stream Durability epic PR 2.
    const dbMessages = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, pageId),
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.isActive, true),
        ne(chatMessages.status, 'streaming')
      ))
      .orderBy(chatMessages.createdAt);

    const conversationHistory: UIMessage[] = await Promise.all(dbMessages.map(msg =>
      convertDbMessageToUIMessage({
        id: msg.id,
        pageId: msg.pageId,
        userId: msg.userId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        createdAt: msg.createdAt,
        isActive: msg.isActive,
        editedAt: msg.editedAt,
        messageType: msg.messageType === 'todo_list' ? 'todo_list' : 'standard',
        status: msg.status,
      })
    ));

    loggers.ai.debug('AI Chat API: Loaded conversation from database', {
      messageCount: conversationHistory.length,
      pageId
    });

    // Sanitize, compact, and elide — all in the unified seam.
    // createUIMessageStream keeps the FULL conversationHistory for the UI;
    // only the model-facing messages go through the seam.
    const prepared = await prepareHistoryForModel({
      history: conversationHistory,
      conversationId: conversationId!,
      source: 'page',
      pageId,
      model: resolvedModelName ?? currentModel,
      provider: resolvedProvider ?? currentProvider,
      systemPrompt: systemPrompt + pageTreePrompt + agentMemoryPrompt + toolDiscoveryPrompt,
      tools: filteredTools as Record<string, unknown>,
      user: user ? { id: user.id, role: user.role } : null,
    });
    const { scheduleCompaction } = prepared;
    const { modelMessages, stableBoundaryIndex } = await finishModelRequest({
      prepared,
      tools: filteredTools,
    });

    // Intentional second sanitize (prepareHistoryForModel already sanitized once):
    // createUIMessageStream must receive the FULL conversation history for the UI
    // (originalMessages), not the compacted/elided model tail in preparedMessages —
    // so conversationHistory is sanitized directly instead of reusing the seam output.
    const sanitizedMessages = sanitizeMessagesForModel(conversationHistory);

    loggers.ai.debug('AI Chat API: Tools configured for Page AI', { toolCount: Object.keys(filteredTools).length });
    loggers.ai.info('AI Chat API: Starting streamText for Page AI', { model: currentModel, pageName: page.title });
    
    let result;

    serverAssistantMessageId = createId();

    const { streamId, signal: abortSignal, controller: abortController } = createStreamAbortController({ userId, messageId: serverAssistantMessageId });
    activeStreamId = streamId;

    const [userProfile] = await userProfilePromise;
    const displayName = userProfile?.displayName ?? user?.name ?? 'Someone';

    // Reuse the row the conversationId validation above already fetched. A conversation
    // that did NOT exist then was created by this request, so it is private by
    // definition (createConversation inserts isShared: false) — which is also the
    // fail-closed answer. Saves a second (and third) read of the same row per message.
    isConversationShared = existingConversation?.isShared === true;

    if (userMessage && userMessage.role === 'user') {
      // Only broadcast to the page channel if the conversation is explicitly shared.
      // Fail closed: no broadcast if the row is missing or private.
      const shouldBroadcast = isConversationShared;
      if (shouldBroadcast) {
        broadcastChatUserMessage({
          message: userMessage,
          pageId: chatId,
          conversationId: conversationId!,
          triggeredBy: { userId: userId!, displayName, browserSessionId },
        }).catch(() => {});
      }
    }

    // Per-conversation in-flight guard. A second send takes the conversation OVER — aborts
    // whatever is live, reconciles its row — rather than being rejected, because a row whose
    // terminal write never landed (crashed process; the write is fire-and-forget) would
    // otherwise lock the user out of their own chat. See stream-liveness.ts.
    //
    // BEST-EFFORT, not an invariant — named honestly. `startGenerationExclusive` closes the
    // check-then-act race documented here previously (the SELECT inside
    // takeOverConversationStreams and the INSERT inside createStreamLifecycle are not atomic on
    // their own) by holding a per-conversation Postgres advisory lock across both. On lock_busy
    // it retries briefly, then proceeds UNLOCKED rather than blocking the send — availability
    // wins over serialization, so a rare contention/pool-exhaustion case can still double-generate.
    // See start-generation-exclusive.ts and the PR 4 board page.
    const generation = await startGenerationExclusive({
      conversationId: conversationId!,
      run: async () => {
        await takeOverConversationStreams({
          conversationId: conversationId!,
          channelId: chatId!,
        });

        const streamLifecycle = await createStreamLifecycle({
          messageId: serverAssistantMessageId!,
          channelId: chatId!,
          conversationId: conversationId!,
          userId: userId!,
          displayName,
          browserSessionId,
          streamId,
          isShared: isConversationShared,
        });

        // Assistant message row at stream start (Server Stream Durability epic, PR 2): a
        // 'streaming' placeholder so history can show in-flight entries and pre-checkpoint
        // process death doesn't silently lose the reply. Same critical section as
        // takeover+lifecycle-create (PR 4 seam note) so a second send observes the stream row
        // and its placeholder together — except on the best-effort insert failure below, where
        // the placeholder is skipped and only the stream row exists (named honestly, not an
        // invariant). Skipped when pre-aborted — the user pressed Stop before streamText ever
        // ran, so there is no generation to show and no execute-end/onFinish write will ever
        // arrive to flip this row out of 'streaming'.
        //
        // Own try/catch, matching every other operation in this closure (takeOverConversationStreams,
        // createStreamLifecycle): `run` must never throw while the advisory lock is held, or
        // start-generation-exclusive.ts's caller misclassifies it as lock-machinery failure and
        // invokes `run` a SECOND time, unlocked — double generation, double billing. Best-effort:
        // a failed placeholder just means history can't show this entry mid-stream; the generation
        // itself still proceeds.
        if (!streamLifecycle.preAborted) {
          try {
            await db.insert(chatMessages).values({
              id: serverAssistantMessageId!,
              pageId: chatId!,
              conversationId: conversationId!,
              role: 'assistant',
              content: '',
              toolCalls: null,
              toolResults: null,
              isActive: true,
              userId: null,
              sourceAgentId: null,
              status: 'streaming',
            });
          } catch (error) {
            loggers.ai.warn('AI Chat API: placeholder assistant row INSERT failed', {
              messageId: serverAssistantMessageId,
              conversationId,
              error: error instanceof Error ? error.message : 'unknown',
            });
          }
        }

        return streamLifecycle;
      },
    });

    lifecycle = generation.result;

    // Bind the terminal write to the abort itself. onAbort (below) already calls finish(true),
    // but it only fires while a streamText is live — and a cross-instance abort now WAITS for
    // this row to settle before deciding what to tell the user. See attachStreamFinisher.
    attachStreamFinisher({ streamId, finish: lifecycle.finish });

    // Pre-aborted: a pending-abort intent was consumed in createStreamLifecycle (#2028 item 1).
    // The user pressed Stop during the preflight window. Abort the controller so streamText
    // never starts; the lifecycle handle is already finished and its finish() is a no-op.
    if (lifecycle.preAborted) {
      abortController.abort();
      removeStream({ streamId });
    }

    try {
      const stream = createUIMessageStream({
        originalMessages: sanitizedMessages,
        generateId: () => serverAssistantMessageId!,
        execute: async ({ writer }) => {
          // Pre-aborted (#2028 item 1, see StreamLifecycleHandle.preAborted) — nothing past this
          // point can ever reach the model. Skip straight to onFinish rather than relying on the
          // already-aborted signal to short-circuit streamText's underlying fetch.
          if (lifecycle!.preAborted) return;

          // Execution feedback (UX spec §7): announce one command indicator
          // per resolved plan ("Using /foo" / "Skipped /foo — reason") as
          // the first parts of the assistant message, in the same order the
          // chips appeared in the user's message. Persisted with the message
          // via onFinish so transcripts keep showing which commands informed
          // the answer.
          commandPlans.forEach((plan, index) => {
            writer.write({
              type: COMMAND_EXECUTION_PART_TYPE,
              id: `${serverAssistantMessageId}-command-${index}`,
              data: commandExecutionDataFromPlan(plan),
            });
          });
          // Resolve once outside the per-attempt factory (the factory is synchronous).
          // Gate tools on the CONCRETE backend model id (resolvedModelName), not the
          // PageSpace alias in currentModel — vision/tool detection pattern-matches the
          // model string, so an alias yields wrong capability flags.
          const modelCapabilitiesForTools = await getModelCapabilities(resolvedModelName!, currentProvider);
          // Server-side, in-request retry: if an attempt drops mid-loop (OpenRouter
          // disconnect) or ends mid-tool without the finish tool, transparently
          // re-drive the loop under one message envelope. The loop lives inside
          // execute(), so onFinish still fires exactly once below.
          const runResult = await runAgentWithRetry({
            writer,
            // Combined with the credit gate's controller (not just the plain abort registry
            // signal) so a mid-stream credit exhaustion is visible to classifyAttempt/isRunAborted
            // the same way it's already visible to streamText below — otherwise the run either
            // retries against an already-exhausted balance or terminalizes as 'complete' instead
            // of 'interrupted'. See Server Stream Durability epic PR 2 review.
            abortSignal: creditAbortController
              ? AbortSignal.any([abortSignal, creditAbortController.signal])
              : abortSignal,
            baseMessages: modelMessages,
            finishToolName: FINISH_TOOL_NAME,
            pauseToolNames: [ASK_USER_TOOL_NAME],
            maxSteps: AGENT_MAX_STEPS,
            startTimeMs: startTime,
            logger: loggers.ai,
            buildStreamText: (messages) => {
              // Volatile per-turn data (timestamp/location/mention/command) is
              // appended to the last user message so the system prefix stays
              // byte-stable and provider prefix caches (Anthropic/OpenAI/Gemini)
              // are not invalidated on every turn — including turns where only
              // the user's current page/drive changed.
              const turnContext = buildVolatileTurnContext({
                timestampPrompt: timestampSystemPrompt,
                locationPrompt,
                mentionPrompt: mentionSystemPrompt,
                commandPrompt: commandSystemPrompt,
              });
              const messagesWithContext = appendTurnContextToLastUserMessage(messages, turnContext);
              // Apply cache breakpoints:
              //   A) last message — covers system+tools+history every step after step 1.
              //   B) stableBoundaryIndex — the first tail message after the compaction
              //      summary (index 1 when a summary exists, 0 = disabled otherwise).
              //      This cross-request breakpoint survives until the next recompaction.
              const cachedMessages = withCacheBreakpoints(messagesWithContext, stableBoundaryIndex);
              return streamText({
              model,
              // Stable system prompt — no volatile sections; stays byte-identical
              // across turns so provider prefix caches survive per request.
              system: systemPrompt + pageTreePrompt + agentMemoryPrompt + toolDiscoveryPrompt,
              messages: cachedMessages,
              tools: filteredTools,
              // hasToolCall(ASK_USER_TOOL_NAME) is documentation: ask_user has no
              // execute, so v6 halts the loop on it anyway (finishReason 'tool-calls').
              stopWhen: [hasToolCall(FINISH_TOOL_NAME), hasToolCall(ASK_USER_TOOL_NAME), stepCountIs(AGENT_MAX_STEPS)],
              // abortSignal from the abort registry — only fires on explicit user stop, never on client disconnect
              // creditAbortController fires when mid-stream credit check determines balance is exhausted
              abortSignal: creditAbortController
                ? AbortSignal.any([abortSignal, creditAbortController.signal])
                : abortSignal,
              onStepFinish: onStepFinishForCredits
                ? async ({ usage }) => { onStepFinishForCredits(usage); }
                : undefined,
              experimental_context: {
                userId,
                timezone: userTimezone,
                aiProvider: currentProvider,
                aiModel: currentModel,
                conversationId,
                locationContext: pageContext ? {
                  currentPage: {
                    id: pageContext.pageId,
                    title: pageContext.pageTitle,
                    type: pageContext.pageType,
                    path: pageContext.pagePath,
                  },
                  currentDrive: pageContext.driveId ? {
                    id: pageContext.driveId,
                    name: pageContext.driveName,
                    slug: pageContext.driveSlug,
                  } : undefined,
                  breadcrumbs: pageContext.breadcrumbs,
                } : undefined,
                // Turn-start snapshot of the agent's working page — tools that
                // shift focus (e.g. create_page) mutate this in place so later
                // tool calls in the same turn track the agent's own actions
                // rather than staying pinned to the turn-start snapshot.
                currentWorkingPage: pageContext ? {
                  id: pageContext.pageId,
                  title: pageContext.pageTitle,
                  type: pageContext.pageType,
                } : undefined,
                modelCapabilities: modelCapabilitiesForTools,
                isAdmin: isAdminUser,
                subscriptionTier: user?.subscriptionTier,
                imageGenerationModel: user?.imageGenerationModel ?? DEFAULT_IMAGE_MODEL,
                chatSource: {
                  type: 'page' as const,
                  agentPageId: chatId,
                  agentTitle: page.title,
                },
                enabledTools: agentEnabledTools ?? null,
                // Bind tool execution to the MCP token's drive scope and RBAC role
                // so a scoped token cannot reach drives outside its scope — or
                // exceed its own membership role — via the agent's broader ACL.
                mcpAllowedDriveIds: getAllowedDriveIds(authResult),
                mcpTokenId: isMCPAuthResult(authResult) ? authResult.tokenId : undefined,
                // Computed once above from deriveMachinePaneBinding — undefined
                // for every conversation that isn't a machine-bound pagespace
                // pane. activeMachine seeds the default-mode sandbox tools'
                // active machine so they operate on the bound machine from the
                // first tool call, without waiting for a switch_machine call.
                machineBinding,
                activeMachine: machineBinding
                  ? { kind: 'existing' as const, machineId: machineBinding.self.machineId }
                  : undefined,
              }, // Pass userId, timezone, AI context, location context, model capabilities, and chat source to tools
              maxRetries: 20, // Increase from default 2 to 20 for better handling of rate limits
              onChunk: ({ chunk }) => {
                const part = chunkToPart(chunk as never);
                if (part) lifecycle!.pushPart(part);
              },
              onAbort: () => {
                loggers.ai.info('AI Chat API: Stream aborted by user', {
                  userId: maskIdentifier(userId!),
                  pageId: chatId,
                  streamId,
                  model: currentModel,
                  provider: currentProvider,
                });
                lifecycle!.finish(true);
              },
              // Re-mark breakpoints per step so mid-loop tool results are cached.
              // stableBoundaryIndex stays fixed (the summary is always at position
              // 0; its first tail neighbour at position 1 remains stable as new
              // messages are appended to the END of the accumulating array).
              prepareStep: ({ messages: stepMessages }) => ({
                messages: withCacheBreakpoints(stepMessages, stableBoundaryIndex),
              }),
            })
          },
          });

          // Billing reads the SUMMED usage / OpenRouter cost across every attempt
          // (steps carry per-request cost metadata). Single onFinish → single
          // consumeCredits → one hold settle: no double-charge, but failed/partial
          // attempts ARE billed because the provider charged us for those tokens.
          agentRun = runResult;

          // Durable server-side persistence — runs regardless of whether the client
          // is still connected. onFinish is coupled to the response stream and may
          // never fire when the mobile client backgrounds mid-stream. This is an
          // idempotent upsert: onFinish, when it runs, refines this write with the
          // richer SDK responseMessage (better tool ordering). When onFinish never
          // runs, this write stands as the sole record of the message.
          //
          // Status: a run the user (or the credit gate) stopped is 'interrupted', not
          // 'complete' — its content, even if non-empty, was cut short, not delivered in
          // full. Unconditional now (not gated on buffered content or abort): a run that
          // exhausted its retries without ever aborting or producing a responseMessage
          // (a sustained provider outage, say) used to fall through BOTH this block and
          // onFinish's `if (responseMessage)` guard, leaving the placeholder stuck at
          // 'streaming' forever — excluded from every reader by default AND rejected by
          // edit/delete's 409 guard, an invisible, permanently-locked ghost row. See
          // Server Stream Durability epic PR 2 — Codex + CodeRabbit review.
          if (chatId && serverAssistantMessageId) {
            const bufferedParts = lifecycle!.getBufferedParts();
            const aborted = isRunAborted({ agentRun, abortSignal });
            const payload = buildAssistantPersistencePayload(serverAssistantMessageId, bufferedParts);
            // This write may be the sole record of the message (see the docblock above) — it
            // must carry the mention gate, or an @mention in a reply whose onFinish never runs
            // is silently never notified (Codex P2, PR #2097). Notification content is the
            // buffered snapshot THIS save persists; if onFinish's refined responseMessage ever
            // contained mention text the buffer missed (which would indicate an onChunk
            // text-forwarding gap, not expected), that delta is not re-notified — filed as an
            // epic D task rather than re-checking on refine, which would duplicate-notify on
            // every normal run.
            try {
              await saveTerminalAssistantMessage({
                messageId: serverAssistantMessageId,
                pageId: chatId,
                conversationId: conversationId!,
                userId: null,
                role: 'assistant',
                ...payload,
                status: aborted ? 'interrupted' : 'complete',
              });
              assistantMessagePersisted = true;
            } catch (e) {
              loggers.ai.error('AI Chat API: execute-end persist failed', e as Error);
            }
          }
        },
        onFinish: async ({ responseMessage }) => {
          // Clean up abort controller from registry
          removeStream({ streamId });

          // Computed once and reused below (persist status + lifecycle.finish's aborted flag)
          // so the two can never disagree about whether this run was stopped.
          const aborted = isRunAborted({ agentRun, abortSignal });

          loggers.ai.debug('AI Chat API: onFinish callback triggered for AI response');
          
          // Enhanced debugging: Log the complete message structure
          loggers.ai.debug('AI Chat API: Response message structure', {
            id: responseMessage?.id,
            role: responseMessage?.role,
            partsCount: responseMessage?.parts?.length || 0,
            partTypes: responseMessage?.parts?.map(p => p.type) || [],
          });
          
          // Log each part in detail
          responseMessage?.parts?.forEach((part, index) => {
            if (part.type === 'text') {
              const text = (part as TextUIPart).text || '';
              loggers.ai.trace(`AI Chat API: Part ${index}: TEXT`, { preview: text.substring(0, 100) });
            } else if (part.type.startsWith('tool-')) {
              const toolPart = part as { state?: string; output?: unknown };
              loggers.ai.trace(`AI Chat API: Part ${index}: TOOL`, { type: part.type, state: toolPart.state, hasOutput: !!toolPart.output });
            } else {
              loggers.ai.trace(`AI Chat API: Part ${index}`, { type: part.type });
            }
          });
          
          // Use the server-generated ID that was sent to the client at stream start.
          const messageId = serverAssistantMessageId!;

          // Extract tool calls/results with safe defaults — responseMessage is absent on
          // exhausted/no-content runs, but usage settlement below still has to run.
          const extractedToolCalls = responseMessage ? extractToolCalls(responseMessage) : [];
          const extractedToolResults = responseMessage ? extractToolResults(responseMessage) : [];

          // Save the AI's response message with tool calls and results (database-first
          // approach). Best-effort: persistence errors must NOT skip usage/credit
          // settlement below — that would leak the gate's hold.
          // Uses buildAssistantPersistencePayload so this path and the execute-end
          // durable path share the same extraction logic and cannot diverge.
          //
          // !lifecycle?.preAborted: the AI SDK always calls onFinish with a non-null
          // responseMessage (an empty {parts: []} shell when execute() wrote nothing), even for a
          // pre-aborted stream where the placeholder INSERT above was deliberately skipped. Without
          // this guard, saveMessageToDatabase's upsert would INSERT a brand-new phantom empty
          // 'interrupted' row for a request that never reached the model — see Server Stream
          // Durability epic PR 2 review.
          if (chatId && responseMessage && !lifecycle?.preAborted) {
            try {
              const { content: messageContent, toolCalls, toolResults, uiMessage } =
                buildAssistantPersistencePayload(messageId, responseMessage.parts);

              loggers.ai.debug('AI Chat API: Saving AI response message', {
                id: messageId,
                contentLength: messageContent.length,
                contentPreview: messageContent.substring(0, 100),
                toolCallsCount: extractedToolCalls.length,
                toolResultsCount: extractedToolResults.length,
                hasContent: messageContent.length > 0,
                hasTools: extractedToolCalls.length > 0 || extractedToolResults.length > 0
              });

              loggers.ai.trace('AI Chat API: Tool tracking', {
                toolCalls: extractedToolCalls.length,
                toolResults: extractedToolResults.length
              });

              // Usually a no-op for mentions: the execute-end save above already carried the
              // gate and latched the once-flag. Attaches only when that save failed or never
              // ran, so this refinement write is the request's first (and only) notifier.
              await saveTerminalAssistantMessage({
                messageId,
                pageId: chatId,
                conversationId: conversationId!,
                userId: null,
                role: 'assistant',
                content: messageContent,
                toolCalls,
                toolResults,
                uiMessage,
                status: aborted ? 'interrupted' : 'complete',
              });
              assistantMessagePersisted = true;

              loggers.ai.debug('AI Chat API: AI response message saved to database with tools');
            } catch (error) {
              loggers.ai.error('AI Chat API: Failed to save AI response message', error as Error);
              // Don't fail the response - persistence errors shouldn't break the chat
            }
          } else if (lifecycle?.preAborted) {
            loggers.ai.debug('AI Chat API: pre-aborted stream, no placeholder row to terminalize');
          } else {
            loggers.ai.warn('AI Chat API: No chatId or response message provided, skipping persistence');
          }

          // Usage + credit settlement ALWAYS runs after runAgentWithRetry completes —
          // regardless of whether a responseMessage was produced or persistence above
          // succeeded. trackUsage settles the gate's hold (holdId) and feeds unit-economics
          // observability; skipping it on exhausted/no-content runs or save failures would
          // leak the hold (the route already set holdHandedOff = true).
          try {
            // Track enhanced AI usage with token counting and cost calculation.
            // Prepaid credit metering ALWAYS runs (both modes) — it settles the gate's
            // hold and feeds unit-economics observability.
            const duration = Date.now() - startTime;

            const usage = agentRun?.accumulatedUsage;
            const steps = agentRun?.accumulatedSteps;
            const inputTokens = usage?.inputTokens ?? undefined;
            const outputTokens = usage?.outputTokens ?? undefined;
            const totalTokens =
              usage?.totalTokens ??
              ((usage?.inputTokens || 0) + (usage?.outputTokens || 0) || undefined);

            // Use enhanced AI monitoring with token usage from SDK
            await AIMonitoring.trackUsage({
              userId: userId!,
              provider: resolvedProvider ?? currentProvider,
              model: resolvedModelName!,
              source: 'chat',
              inputTokens,
              outputTokens,
              totalTokens,
              cachedInputTokens: usage?.cachedInputTokens,
              reasoningTokens: usage?.reasoningTokens,
              providerCostDollars: extractOpenRouterCostDollars(steps),
              openrouterGenerationIds: extractOpenRouterGenerationIds(steps),
              duration,
              conversationId, // Use actual conversation ID instead of pageId
              messageId,
              pageId: chatId,
              // Empty string (no drive in view) must read as "no drive", not a
              // literal '' driveId — matches the truthy-guards used elsewhere
              // in this file for the same pageContext.driveId field.
              driveId: pageContext?.driveId || undefined,
              // 'exhausted' = retry shell gave up (failure); clean/terminal = a real
              // completion. Cost still settles regardless (the provider charged us).
              success: agentRun?.finalOutcome !== 'exhausted',
              holdId,
              metadata: {
                pageName: page.title,
                toolCallsCount: extractedToolCalls.length,
                toolResultsCount: extractedToolResults.length,
                hasTools: extractedToolCalls.length > 0 || extractedToolResults.length > 0,
                reasoningTokens: usage?.reasoningTokens,
                cachedInputTokens: usage?.cachedInputTokens,
                retryAttempts: agentRun?.attempts,
                retryOutcome: agentRun?.finalOutcome,
                retryTerminalReason: agentRun?.terminalReason,
              }
            });

            // Credit balance is pushed live by consumeCredits itself (called from
            // AIMonitoring.trackUsage above), which now broadcasts at every balance
            // mutation — so the header widget updates without a route-level emit here.

            // Track tool usage separately for analytics
            if (extractedToolCalls.length > 0) {
              for (const toolCall of extractedToolCalls) {
                await AIMonitoring.trackToolUsage({
                  userId: userId!,
                  provider: currentProvider,
                  model: resolvedModelName!,
                  toolName: toolCall.toolName,
                  toolId: toolCall.toolCallId,
                  args: undefined,
                  conversationId, // Use actual conversation ID instead of pageId
                  pageId: chatId,
                  success: true
                });
              }

              // Also track feature usage
              trackFeature(userId!, 'ai_tools_used', {
                toolCount: extractedToolCalls.length,
                provider: currentProvider,
                model: currentModel
              });
            }
          } catch (error) {
            loggers.ai.error('AI Chat API: Failed to settle AI usage/credits', error as Error);
            // Don't fail the response - but the hold may remain for the reconcile sweep.
          }

          // Schedule compaction for the NEXT request (summarises old tail via after()).
          // Runs after the response is fully sent; non-fatal if it fails.
          scheduleCompaction();

          // Reflect a user stop, including one that landed during inter-attempt backoff or
          // raced in after the loop broke (onAbort only fires while a streamText is live).
          // finish() is idempotent, so this is a no-op if onAbort already ran.
          lifecycle!.finish(aborted);
        },
      });

      result = {
        toUIMessageStreamResponse: () => createUIMessageStreamResponse({
          stream,
          headers: { [STREAM_ID_HEADER]: streamId },
        }),
      };
    } catch (streamError) {
      removeStream({ streamId });
      // Captured BEFORE finish() for the same reason as the outer catch below — this inner
      // catch's own finish() call would otherwise clear the buffer before the outer catch's
      // cleanup ever gets a chance to read it.
      bufferedPartsAtStreamError = lifecycle.getBufferedParts();
      lifecycle.finish(true);
      loggers.ai.error('AI Chat API: Failed to create stream', streamError as Error, {
        message: streamError instanceof Error ? streamError.message : 'Unknown error',
        stack: streamError instanceof Error ? streamError.stack : undefined
      });
      throw streamError;
    }

    loggers.ai.debug('AI Chat API: Returning visual-content-aware stream response');

    // The stream's onFinish now owns hold release (via AIMonitoring.trackUsage).
    holdHandedOff = true;
    // Return the enhanced UI message stream response with visual content injection
    return result.toUIMessageStreamResponse();

  } catch (error) {
    if (activeStreamId !== undefined) {
      removeStream({ streamId: activeStreamId });
    }
    // Captured BEFORE finish() — finish() deletes the multicast registry entry backing
    // getBufferedParts(), so calling it after finish() would always see an empty buffer and
    // silently discard any real partial content the cleanup write below is meant to preserve.
    // Prefers bufferedPartsAtStreamError (captured by the INNER catch above, before ITS OWN
    // finish() call already cleared the registry) when set — a fresh getBufferedParts() call
    // here would otherwise always see [] for exactly the createUIMessageStream-threw case this
    // cleanup exists for.
    const bufferedPartsAtError = bufferedPartsAtStreamError ?? lifecycle?.getBufferedParts() ?? [];
    lifecycle?.finish(true);

    // Last-resort cleanup: something threw before execute-end or onFinish ever got a chance to
    // settle the placeholder row (e.g. createUIMessageStream itself failed to construct). Without
    // this, the row is stuck at 'streaming' forever — excluded from every reader by default AND
    // rejected by edit/delete's 409 guard. Guarded by assistantMessagePersisted so this can never
    // downgrade an already-'complete'/'interrupted' row written earlier in the SAME request (e.g.
    // execute-end succeeded, then something later threw before the response returned). Best-effort:
    // must not itself throw or block the error response.
    //
    // Requires `lifecycle` itself (not just `!lifecycle?.preAborted`) so this never fires for a
    // throw that happened INSIDE startGenerationExclusive's callback, before `lifecycle` is ever
    // assigned (line ~1297) — e.g. takeOverConversationStreams or createStreamLifecycle failing
    // (the placeholder INSERT itself has its own try/catch and can no longer throw here). In
    // that window no placeholder row exists at all, so this upsert would INSERT a stray phantom
    // 'interrupted' row for a request that never started generating.
    if (!assistantMessagePersisted && serverAssistantMessageId && chatId && conversationId && lifecycle && !lifecycle.preAborted) {
      try {
        // Same exactly-once contract as execute-end/onFinish: this is a terminal write that
        // flips the placeholder out of 'streaming', so if it is the request's FIRST successful
        // terminal write (it only runs when the other two never landed), it carries the
        // mention gate — otherwise a buffered @mention in the salvaged partial reply would be
        // notified by no one (the materializer skips rows the route already flipped).
        await saveTerminalAssistantMessage({
          messageId: serverAssistantMessageId,
          pageId: chatId,
          conversationId,
          userId: null,
          role: 'assistant',
          ...buildAssistantPersistencePayload(serverAssistantMessageId, bufferedPartsAtError),
          status: 'interrupted',
        });
      } catch (cleanupError) {
        loggers.ai.error('AI Chat API: failed to terminalize placeholder row after error', cleanupError as Error);
      }
    }

    loggers.ai.error('AI Chat API Error', error as Error, {
      userId,
      chatId,
      provider: selectedProvider,
      model: selectedModel,
      responseTime: Date.now() - startTime
    });

    const usage = agentRun?.accumulatedUsage;
    const steps = agentRun?.accumulatedSteps;

    // Track AI usage even for errors using enhanced monitoring
    // Note: conversationId might not be available in error path, use chatId as fallback
    await AIMonitoring.trackUsage({
      userId: userId || 'unknown',
      provider: (resolvedProvider ?? selectedProvider) || 'unknown',
      model: resolvedModelName ?? selectedModel ?? 'unknown',
      source: 'chat',
      inputTokens: usage?.inputTokens ?? undefined,
      outputTokens: usage?.outputTokens ?? undefined,
      totalTokens:
        usage?.totalTokens ??
        ((usage?.inputTokens || 0) + (usage?.outputTokens || 0) || undefined),
      cachedInputTokens: usage?.cachedInputTokens,
      reasoningTokens: usage?.reasoningTokens,
      providerCostDollars: extractOpenRouterCostDollars(steps),
      openrouterGenerationIds: extractOpenRouterGenerationIds(steps),
      duration: Date.now() - startTime,
      conversationId: conversationId || chatId, // Use conversationId if available, fallback to chatId
      pageId: chatId,
      driveId: undefined,
      success: false,
      holdId,
      error: error instanceof Error ? error.message : 'Unknown error',
      metadata: {
        errorType: error instanceof Error ? error.name : 'UnknownError',
        reasoningTokens: usage?.reasoningTokens,
        cachedInputTokens: usage?.cachedInputTokens,
      }
    });
    // The error-path trackUsage above released the hold; don't double-release.
    holdHandedOff = true;

    // Return a proper error response
    return NextResponse.json({
      error: 'Failed to process chat request. Please try again.'
    }, { status: 500 });
  } finally {
    // Pre-generation early return: free the reservation the stream never took over.
    if (holdId && !holdHandedOff) void releaseHold(holdId).catch(() => {});
  }
}

/**
 * GET handler to check multi-provider configuration status and current settings
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_chat_settings', resourceId: 'get', details: { reason: 'auth_failed', method: 'GET', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    // Get pageId from query params
    const url = new URL(request.url);
    const pageId = url.searchParams.get('pageId');
    
    // Get user's current provider settings
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    
    // Get page-specific settings if pageId provided
    let currentProvider = user?.currentAiProvider || DEFAULT_PROVIDER;
    let currentModel = user?.currentAiModel || DEFAULT_MODEL;
    
    if (pageId) {
      const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
      if (page) {
        // Use page-specific settings if they exist, otherwise fallback to user settings
        currentProvider = page.aiProvider || currentProvider;
        currentModel = page.aiModel || currentModel;
      }
    }
    
    const providers = buildProviderAvailabilityMap({
      isOnPrem: isOnPrem(),
      onPremAllowed: ONPREM_ALLOWED_PROVIDERS,
    });

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'ai_chat_settings', resourceId: pageId || userId, details: {
      action: 'get_provider_settings',
    } });

    return NextResponse.json({
      currentProvider,
      currentModel,
      providers,
      isAnyProviderConfigured: Object.values(providers).some((p) => p.isAvailable),
    });

  } catch (error) {
    loggers.ai.error('Error checking provider settings', error as Error);
    return NextResponse.json({ 
      error: 'Failed to check settings' 
    }, { status: 500 });
  }
}

/**
 * Validate provider and model combination
 * Ensures the provider/model pair is supported and user has access
 */
async function validateProviderModel(
  provider: string,
  model: string,
  userId: string
): Promise<{ valid: boolean; reason?: string }> {
  // Check if provider is valid
  if (!(ALL_PROVIDER_NAMES as readonly string[]).includes(provider)) {
    return {
      valid: false,
      reason: `Invalid provider: ${provider}. Supported providers: ${ALL_PROVIDER_NAMES.join(', ')}`
    };
  }

  // Validate model string format (basic sanity check)
  if (!model || typeof model !== 'string' || model.length > 100) {
    return {
      valid: false,
      reason: 'Invalid model format'
    };
  }

  // Check subscription requirements for paid models
  try {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const isAdminUser = user?.role === 'admin';
    const admission = resolveGenerationAdmission({
      provider,
      model,
      subscriptionTier: user?.subscriptionTier ?? undefined,
      isAdmin: isAdminUser,
      requiresProSubscription,
    });
    if (!admission.allowed) {
      return {
        valid: false,
        reason:
          admission.reason === 'provider_admin_only'
            ? 'This provider is restricted to administrators.'
            : 'A paid plan is required for this model',
      };
    }
  } catch (error) {
    loggers.ai.error('Error checking subscription requirements', error as Error);
    return {
      valid: false,
      reason: 'Unable to validate subscription requirements'
    };
  }

  // Additional provider-specific validation could go here
  // For now, basic validation is sufficient

  return { valid: true };
}

/**
 * PATCH handler to update page-specific AI settings
 */
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_chat_settings', resourceId: 'update', details: { reason: 'auth_failed', method: 'PATCH', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }

    const body = await request.json();

    // Enhanced input validation with type checking
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const { pageId, provider, model, expectedRevision } = body;

    // Validate pageId (should be a CUID)
    if (!pageId || typeof pageId !== 'string' || pageId.length < 10 || pageId.length > 30) {
      return NextResponse.json(
        { error: 'Invalid pageId format' },
        { status: 400 }
      );
    }

    // Validate provider
    if (!provider || typeof provider !== 'string' || provider.length > 50) {
      return NextResponse.json(
        { error: 'Provider is required and must be a valid string' },
        { status: 400 }
      );
    }

    // Validate model
    if (!model || typeof model !== 'string' || model.length > 100) {
      return NextResponse.json(
        { error: 'Model is required and must be a valid string' },
        { status: 400 }
      );
    }

    // Sanitize inputs (trim whitespace and basic cleanup)
    const sanitizedProvider = provider.trim();
    const sanitizedModel = model.trim();
    const sanitizedPageId = pageId.trim();

    // Verify the user has access to this page
    const [page] = await db.select().from(pages).where(eq(pages.id, sanitizedPageId));
    if (!page) {
      return NextResponse.json(
        { error: 'Page not found' },
        { status: 404 }
      );
    }

    // Check if user has permission to edit this page (SECURITY: Critical permission enforcement)
    const canEdit = await canPrincipalEditPage(auth, sanitizedPageId);
    if (!canEdit) {
      loggers.ai.warn('AI Settings PATCH: User lacks edit permission', {
        userId: auth.userId,
        pageId: sanitizedPageId
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'ai_chat_settings', resourceId: sanitizedPageId, details: { reason: 'no_edit_permission', method: 'PATCH' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'You do not have permission to modify this page' },
        { status: 403 }
      );
    }

    // Validate provider and model combination (SECURITY: Validate permitted combinations)
    const validation = await validateProviderModel(sanitizedProvider, sanitizedModel, auth.userId);
    if (!validation.valid) {
      loggers.ai.warn('AI Settings PATCH: Invalid provider/model combination', {
        userId: auth.userId,
        pageId: sanitizedPageId,
        provider: sanitizedProvider,
        model: sanitizedModel,
        reason: validation.reason
      });
      return NextResponse.json(
        { error: validation.reason || 'Invalid provider/model combination' },
        { status: 400 }
      );
    }

    // Update page settings
    try {
      const actorInfo = await getActorInfo(auth.userId);
      await applyPageMutation({
        pageId: sanitizedPageId,
        operation: 'agent_config_update',
        updates: {
          aiProvider: sanitizedProvider,
          aiModel: sanitizedModel,
        },
        updatedFields: ['aiProvider', 'aiModel'],
        expectedRevision: typeof expectedRevision === 'number' ? expectedRevision : undefined,
        context: {
          userId: auth.userId,
          actorEmail: actorInfo.actorEmail,
          actorDisplayName: actorInfo.actorDisplayName,
          resourceType: 'agent',
        },
      });
    } catch (error) {
      if (error instanceof PageRevisionMismatchError) {
        return NextResponse.json(
          {
            error: error.message,
            currentRevision: error.currentRevision,
            expectedRevision: error.expectedRevision,
          },
          { status: error.expectedRevision === undefined ? 428 : 409 }
        );
      }
      throw error;
    }

    loggers.ai.info('AI Settings PATCH: Page settings updated successfully', {
      userId: auth.userId,
      pageId: sanitizedPageId,
      provider: sanitizedProvider,
      model: sanitizedModel
    });

    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'ai_chat_settings', resourceId: sanitizedPageId, details: {
      action: 'update_page_settings',
      provider: sanitizedProvider,
      model: sanitizedModel,
    } });

    return NextResponse.json({
      success: true,
      message: 'Page AI settings updated successfully',
      provider: sanitizedProvider,
      model: sanitizedModel,
    });
  } catch (error) {
    loggers.ai.error('Failed to update page AI settings', error as Error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
