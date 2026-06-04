import { NextResponse } from 'next/server';
import {
  streamText,
  convertToModelMessages,
  UIMessage,
  stepCountIs,
  hasToolCall,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type LanguageModelUsage,
  type TextUIPart,
  type ToolSet,
} from 'ai';
import { ONPREM_ALLOWED_PROVIDERS, isAdminOnlyProvider, getProviderTier } from '@/lib/ai/core/ai-providers-config';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { mergeToolSets } from '@/lib/ai/core/tool-utils';
import { finishTool, FINISH_TOOL_NAME } from '@/lib/ai/tools/finish-tool';
import { requiresProSubscription, createRateLimitResponse } from '@/lib/subscription/rate-limit-middleware';
// LEGACY: daily-quota path, active only when isCreditsModeEnabled() is OFF. Remove at final credits cutover.
import { getCurrentUsage, incrementUsage } from '@/lib/subscription/usage-service';
import { isCreditsModeEnabled, MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { creditGateErrorResponse } from '@/lib/subscription/credit-gate-response';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { broadcastChatUserMessage } from '@/lib/websocket';
import { createStreamLifecycle, type StreamLifecycleHandle } from '@/lib/ai/core/stream-lifecycle';
import { chunkToPart } from '@/lib/ai/streams/chunkToPart';
import { validateBrowserSessionIdHeader } from '@/lib/ai/core/browser-session-id-validation';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import {
  createAIProvider,
  updateUserProviderSettings,
  createProviderErrorResponse,
  isProviderError,
  type ProviderRequest,
  buildProviderAvailabilityMap,
  pageSpaceTools,
  extractMessageContent,
  extractToolCalls,
  extractToolResults,
  saveMessageToDatabase,
  sanitizeMessagesForModel,
  convertDbMessageToUIMessage,
  processMentionsInMessage,
  buildMentionSystemPrompt,
  buildTimestampSystemPrompt,
  buildSystemPrompt,
  buildPersonalizationPrompt,
  filterToolsForReadOnly,
  getPageTreeContext,
  getModelCapabilities,
  convertMCPToolsToAISDKSchemas,
  parseMCPToolName,
  sanitizeToolNamesForProvider,
  getUserPersonalization,
} from '@/lib/ai/core';
import { applyToolExposureMode } from '@/lib/ai/tools/tool-exposure';

// Runtime-toggled tools that must stay directly callable even in search mode.
const ALWAYS_UPFRONT_TOOLS = new Set(['web_search']);

// Hard cap on agent tool-loop steps per attempt. Must match the stepCountIs() in
// stopWhen and the maxSteps passed to runAgentWithRetry.
const AGENT_MAX_STEPS = 100;
import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { chatMessages, pages, drives } from '@pagespace/db/schema/core';
import { userProfiles } from '@pagespace/db/schema/members';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskIdentifier } from '@/lib/logging/mask';
import { trackFeature } from '@pagespace/lib/monitoring/activity-tracker';
import { AIMonitoring, extractOpenRouterCostDollars, type ProviderMetadataCarrier } from '@pagespace/lib/monitoring/ai-monitoring';
import type { MCPTool } from '@/types/mcp';
import { getMCPBridge } from '@/lib/mcp';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';
import { expandMentionsToUserIds } from '@/lib/channels/expand-group-mentions';
import { createMentionNotification } from '@pagespace/lib/notifications/notifications';
import {
  createStreamAbortController,
  removeStream,
  STREAM_ID_HEADER,
} from '@/lib/ai/core/stream-abort-registry';
import { runAgentWithRetry, type RunAgentWithRetryResult } from '@/lib/ai/core/run-agent-with-retry';
import { validateUserMessageFileParts, hasFileParts } from '@/lib/ai/core/validate-image-parts';
import { hasVisionCapability } from '@/lib/ai/core/model-capabilities';
import { conversationRepository } from '@/lib/repositories/conversation-repository';


// Allow streaming responses up to 5 minutes for complex AI agent interactions
export const maxDuration = 300;


export async function POST(request: Request) {
  const startTime = Date.now();
  let userId: string | undefined;
  let chatId: string | undefined;
  let conversationId: string | undefined;
  let selectedProvider: string | undefined;
  let selectedModel: string | undefined;
  let usagePromise: Promise<LanguageModelUsage | undefined> | undefined;
  let stepsPromise: Promise<ProviderMetadataCarrier[] | undefined> | undefined;
  // Outcome of the retry shell, shared from execute() to onFinish() (success flag,
  // abort detection during inter-attempt backoff, retry observability).
  let agentRun: RunAgentWithRetryResult | undefined;
  let lifecycle: StreamLifecycleHandle | undefined;
  let activeStreamId: string | undefined;
  let serverAssistantMessageId: string | undefined;
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
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_chat', resourceId: 'post', details: { reason: 'auth_failed', method: 'POST' }, riskScore: 0.5 });
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
      pageContext,
      mcpTools, // MCP tool schemas from desktop client (optional)
      isReadOnly, // Optional read-only mode toggle
      webSearchEnabled, // Optional web search toggle (defaults to false)
    }: {
      messages: UIMessage[],
      chatId?: string,
      conversationId?: string, // Optional - will be auto-generated if not provided
      selectedProvider?: string,
      selectedModel?: string,
      mcpTools?: MCPTool[], // MCP tool schemas from desktop (client-side execution)
      isReadOnly?: boolean, // Optional read-only mode toggle
      webSearchEnabled?: boolean, // Optional web search toggle (defaults to false)
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
    const canView = await canUserViewPage(userId, chatId);
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

    const canEdit = await canUserEditPage(userId, chatId);
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

    loggers.ai.debug('AI Page Chat API: Using custom agent configuration', {
      hasCustomSystemPrompt: !!customSystemPrompt,
      pageName: page.title,
      includeDrivePrompt: page.includeDrivePrompt,
      hasDrivePrompt: !!drivePromptPrefix
    });

    // Auto-generate conversationId if not provided (seamless UX)
    conversationId = requestConversationId || createId();
    loggers.ai.debug('AI Chat API: Conversation session', {
      conversationId,
      isNewConversation: !requestConversationId
    });

    // Process @mentions in the user's message
    let mentionSystemPrompt = '';
    let mentionedPageIds: string[] = [];

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
    const creditGate = await canConsumeAI(userId, (user?.subscriptionTier ?? 'free') as SubscriptionTier, {
      estCostCents: estimateChatHoldCentsForModel(selectedModel),
      maxInFlight: MAX_CHAT_INFLIGHT,
    });
    if (!creditGate.allowed) {
      loggers.ai.warn('AI Chat API: AI credit gate denied', { userId, reason: creditGate.reason });
      return creditGateErrorResponse(creditGate.reason);
    }
    holdId = creditGate.holdId;

    // Eagerly ensure a conversations row exists so the creator can always see
    // their own conversation. isShared defaults to false (private). Idempotent
    // via onConflictDoNothing, so safe for every message in a conversation.
    // Awaited so the row is visible to the broadcast gate below; errors are
    // swallowed (non-fatal) and the gate falls back to no-broadcast on failure.
    // Runs AFTER the credit gate so a denied first prompt leaves no orphaned row.
    await conversationRepository.createConversation(conversationId, userId!, chatId).catch(() => {});

    // Save user's message immediately to database (database-first approach)
    const userMessage = messages[messages.length - 1]; // Last message is the new user message
    if (userMessage && userMessage.role === 'user') {
      try {
        const messageId = userMessage.id || createId();
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
    }
    
    // Get user's current AI provider settings (user was loaded above for the gate)
    const currentProvider = selectedProvider || user?.currentAiProvider || 'pagespace';
    const currentModel = selectedModel || user?.currentAiModel || 'glm-4.5-air';

    // Kick off the userProfiles displayName fetch early so it overlaps with downstream
    // setup (rate-limit checks, tool resolution, conversation load) and never blocks the
    // lifecycle handoff. Falls back to [] on failure so consumers don't have to handle rejection.
    const userProfilePromise = db
      .select({ displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1)
      .catch(() => [] as { displayName: string | null }[]);

    // Pro subscription check for special providers
    const { requiresProSubscription, createSubscriptionRequiredResponse, createAdminRestrictedResponse } = await import('@/lib/subscription/rate-limit-middleware');

    const isAdminUser = user?.role === 'admin';

    // Admin-only providers (e.g. paid OpenRouter) are restricted to global admins, even if a
    // stored selection survives a role downgrade.
    if (isAdminOnlyProvider(currentProvider) && !isAdminUser) {
      loggers.ai.warn('AI Chat API: admin-only provider blocked for non-admin', {
        userId,
        provider: currentProvider,
        model: currentModel,
      });
      return createAdminRestrictedResponse();
    }

    // Check if provider requires Pro subscription
    if (requiresProSubscription(currentProvider, currentModel, user?.subscriptionTier, isAdminUser)) {
      loggers.ai.warn('AI Chat API: Pro subscription required', {
        userId,
        provider: currentProvider,
        model: currentModel,
        subscriptionTier: user?.subscriptionTier
      });
      return createSubscriptionRequiredResponse();
    }

    // Usage tracking will be handled in onFinish callback for PageSpace providers only
    loggers.ai.debug('AI Chat API: Will track usage in onFinish for PageSpace providers', {
      userId,
      provider: currentProvider,
      isPageSpaceProvider: currentProvider === 'pagespace'
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

    const providerResult = await createAIProvider(userId, providerRequest);

    if (isProviderError(providerResult)) {
      return createProviderErrorResponse(providerResult);
    }

    // Use the resolved model name for billing. currentModel may be a PageSpace
    // tier alias ('standard'/'pro') or an unpriced default ('glm-4.5-air'), which
    // would meter at $0; providerResult.modelName is the real backend model id.
    const { model, modelName: resolvedModelName } = providerResult;

    // Update user's current provider/model if changed
    await updateUserProviderSettings(userId, selectedProvider, selectedModel);

    // LEGACY daily-quota path (credits mode OFF): prod's "old way". The credit gate
    // above already metered (and, when enforcement is ON, blocked); here we layer the
    // legacy per-tier daily limit so a dark-launch environment behaves exactly as before.
    // getCurrentUsage returns unlimited when !isBillingEnabled(), so onprem/tenant bypass.
    // Remove at final credits cutover.
    if (!isCreditsModeEnabled()) {
      const providerType = getProviderTier(currentProvider, currentModel);
      const currentUsage = await getCurrentUsage(userId, providerType);
      if (!currentUsage.success || currentUsage.remainingCalls <= 0) {
        loggers.ai.warn('AI Chat API: Legacy daily rate limit exceeded', {
          userId: maskIdentifier(userId),
          providerType,
          limit: currentUsage.limit,
          remaining: currentUsage.remainingCalls,
        });
        // The gate placed a hold above (it runs even in OFF mode, for metering); this
        // early return never streams, so release it now rather than wait for the sweep.
        if (holdId && !holdHandedOff) void releaseHold(holdId).catch(() => {});
        return createRateLimitResponse(providerType, currentUsage.limit);
      }
    }

    // Parse read-only mode (defaults to false for full access)
    const readOnlyMode = isReadOnly === true;
    // Parse web search mode (defaults to false - disabled)
    const webSearchMode = webSearchEnabled === true;
    loggers.ai.debug('AI Page Chat API: Tool modes', { isReadOnly: readOnlyMode, webSearchEnabled: webSearchMode });

    // Step 1: Apply isReadOnly filter to PageSpace baseline tools.
    const baseTools = filterToolsForReadOnly(pageSpaceTools, readOnlyMode);

    // Step 2: Extract web_search so it can be handled as a runtime-toggle override
    // independently of the per-agent allowlist.
    const { web_search: webSearchToolDef, ...baseToolsWithoutWebSearch } = baseTools as Record<string, ToolSet[string]>;

    // Step 3: Apply per-agent PageSpace tool allowlist.
    // null/undefined = unconfigured page — no restriction (backwards compat).
    // []            = zero tools selected — block all PageSpace tools.
    // ['tool1', …]  = only those tools.
    const agentEnabledTools = page.enabledTools as string[] | null;
    let filteredTools: ToolSet;
    if (agentEnabledTools != null) {
      filteredTools = Object.fromEntries(
        Object.entries(baseToolsWithoutWebSearch).filter(([name]) => agentEnabledTools.includes(name))
      ) as ToolSet;
    } else {
      filteredTools = baseToolsWithoutWebSearch as ToolSet;
    }

    // Step 4: webSearchEnabled is a runtime input toggle that overrides the allowlist.
    // If the user toggled web search on in the composer, they get web_search regardless of enabledTools.
    if (webSearchMode && webSearchToolDef) {
      filteredTools = { ...filteredTools, web_search: webSearchToolDef };
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
        const mcpToolsWithExecute: Record<string, unknown> = {};
        for (const [toolName, toolSchema] of Object.entries(mcpToolSchemas)) {
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

    loggers.ai.debug('AI Chat API: Loading conversation history', {
      pageId: chatId
    });

    const pageId = chatId as string;
    const dbMessages = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, pageId),
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.isActive, true)
      ))
      .orderBy(chatMessages.createdAt);

    const conversationHistory: UIMessage[] = dbMessages.map(msg =>
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
      })
    );

    loggers.ai.debug('AI Chat API: Loaded conversation from database', {
      messageCount: conversationHistory.length,
      pageId
    });

    // Convert UIMessages to ModelMessages for the AI model
    // First sanitize messages to remove tool parts without results (prevents "input-available" state errors)
    // NOTE: We use database-loaded messages, NOT messages from client
    const sanitizedMessages = sanitizeMessagesForModel(conversationHistory);
    const modelMessages = convertToModelMessages(sanitizedMessages, {
      tools: filteredTools  // Use original tools - no wrapping needed
    });

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
    let systemPrompt: string;
    if (customSystemPrompt) {
      // Use custom system prompt with page context injected
      // Prepend drive prompt if enabled and available
      systemPrompt = drivePromptPrefix + customSystemPrompt;
      if (pageContext) {
        systemPrompt += `\n\nYou are operating within the page "${pageContext.pageTitle}" in the "${pageContext.driveName}" drive. Your current location: ${pageContext.pagePath}`;
      }
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
        'page',
        pageContext ? {
          driveName: pageContext.driveName,
          driveSlug: pageContext.driveSlug,
          driveId: pageContext.driveId,
          pagePath: pageContext.pagePath,
          pageType: pageContext.pageType,
          breadcrumbs: pageContext.breadcrumbs,
        } : undefined,
        readOnlyMode,
        personalization ?? undefined
      );
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

    loggers.ai.debug('AI Chat API: Tools configured for Page AI', { toolCount: Object.keys(filteredTools).length });
    loggers.ai.info('AI Chat API: Starting streamText for Page AI', { model: currentModel, pageName: page.title });
    
    let result;

    serverAssistantMessageId = createId();

    const { streamId, signal: abortSignal } = createStreamAbortController({ userId, messageId: serverAssistantMessageId });
    activeStreamId = streamId;

    const [userProfile] = await userProfilePromise;
    const displayName = userProfile?.displayName ?? user?.name ?? 'Someone';

    if (userMessage && userMessage.role === 'user') {
      // Only broadcast to the page channel if the conversation is explicitly shared.
      // Fail closed: no broadcast if the row is missing or private.
      const convRow = await conversationRepository.getConversation(conversationId!).catch(() => null);
      const shouldBroadcast = convRow?.isShared === true;
      if (shouldBroadcast) {
        broadcastChatUserMessage({
          message: userMessage,
          pageId: chatId,
          conversationId: conversationId!,
          triggeredBy: { userId: userId!, displayName, browserSessionId },
        }).catch(() => {});
      }
    }

    lifecycle = await createStreamLifecycle({
      messageId: serverAssistantMessageId,
      channelId: chatId,
      conversationId: conversationId!,
      userId: userId!,
      displayName,
      browserSessionId,
    });

    try {
      const stream = createUIMessageStream({
        originalMessages: sanitizedMessages,
        generateId: () => serverAssistantMessageId!,
        execute: async ({ writer }) => {
          // Resolve once outside the per-attempt factory (the factory is synchronous).
          const modelCapabilitiesForTools = await getModelCapabilities(currentModel, currentProvider);
          // Server-side, in-request retry: if an attempt drops mid-loop (OpenRouter
          // disconnect) or ends mid-tool without the finish tool, transparently
          // re-drive the loop under one message envelope. The loop lives inside
          // execute(), so onFinish still fires exactly once below.
          const runResult = await runAgentWithRetry({
            writer,
            abortSignal,
            baseMessages: modelMessages,
            finishToolName: FINISH_TOOL_NAME,
            maxSteps: AGENT_MAX_STEPS,
            startTimeMs: startTime,
            logger: loggers.ai,
            buildStreamText: (messages) => streamText({
              model,
              system: systemPrompt + mentionSystemPrompt + timestampSystemPrompt + pageTreePrompt + toolDiscoveryPrompt,
              messages,
              tools: filteredTools,
              stopWhen: [hasToolCall(FINISH_TOOL_NAME), stepCountIs(AGENT_MAX_STEPS)],
              // abortSignal from the abort registry — only fires on explicit user stop, never on client disconnect
              abortSignal,
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
                modelCapabilities: modelCapabilitiesForTools,
                chatSource: {
                  type: 'page' as const,
                  agentPageId: chatId,
                  agentTitle: page.title,
                },
                enabledTools: agentEnabledTools ?? null,
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
            }),
          });

          // Billing reads the SUMMED usage / OpenRouter cost across every attempt
          // (steps carry per-request cost metadata). Single onFinish → single
          // consumeCredits → one hold settle: no double-charge, but failed/partial
          // attempts ARE billed because the provider charged us for those tokens.
          usagePromise = Promise.resolve(runResult.accumulatedUsage);
          stepsPromise = Promise.resolve(runResult.accumulatedSteps);
          agentRun = runResult;
        },
        onFinish: async ({ responseMessage }) => {
          // Clean up abort controller from registry
          removeStream({ streamId });

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
          
          // Save the AI's response message with tool calls and results (database-first approach)
          if (chatId && responseMessage) {
            try {
              // Use the server-generated ID that was sent to the client at stream start
              // This ensures the saved message ID matches what the client has
              const messageId = serverAssistantMessageId!;
              const messageContent = extractMessageContent(responseMessage);
              
              // Extract tool calls and results from the response
              const extractedToolCalls = extractToolCalls(responseMessage);
              const extractedToolResults = extractToolResults(responseMessage);
              
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
              
              // Use the new helper function to save the message with complete UIMessage for chronological ordering
              await saveMessageToDatabase({
                messageId,
                pageId: chatId,
                conversationId: conversationId!, // Group messages into conversation sessions
                userId: null, // AI message
                role: 'assistant',
                content: messageContent,
                toolCalls: extractedToolCalls.length > 0 ? extractedToolCalls : undefined,
                toolResults: extractedToolResults.length > 0 ? extractedToolResults : undefined,
                uiMessage: responseMessage, // Pass complete UIMessage to preserve part ordering
              });
              
              loggers.ai.debug('AI Chat API: AI response message saved to database with tools');

              // LEGACY daily-quota counting (credits mode OFF): keep the old per-tier
              // counter moving so the restored UsageCounter is accurate on prod during
              // dark launch. Best-effort — never fail the chat. Remove at final cutover.
              if (!isCreditsModeEnabled()) {
                try {
                  await incrementUsage(userId!, getProviderTier(currentProvider, currentModel));
                } catch (usageError) {
                  loggers.ai.error('AI Chat API: legacy usage increment failed', usageError as Error, {
                    userId: maskIdentifier(userId!),
                  });
                }
              }

              // Track enhanced AI usage with token counting and cost calculation.
              // Prepaid credit metering ALWAYS runs (both modes) — it settles the gate's
              // hold and feeds unit-economics observability.
              const duration = Date.now() - startTime;

              const usage = usagePromise ? await usagePromise : undefined;
              const steps = stepsPromise ? await stepsPromise : undefined;
              const inputTokens = usage?.inputTokens ?? undefined;
              const outputTokens = usage?.outputTokens ?? undefined;
              const totalTokens =
                usage?.totalTokens ??
                ((usage?.inputTokens || 0) + (usage?.outputTokens || 0) || undefined);

              // Use enhanced AI monitoring with token usage from SDK
              await AIMonitoring.trackUsage({
                userId: userId!,
                provider: currentProvider,
                model: resolvedModelName,
                source: 'chat',
                inputTokens,
                outputTokens,
                totalTokens,
                providerCostDollars: extractOpenRouterCostDollars(steps),
                duration,
                conversationId, // Use actual conversation ID instead of pageId
                messageId,
                pageId: chatId,
                driveId: pageContext?.driveId,
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
                    model: resolvedModelName,
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
              loggers.ai.error('AI Chat API: Failed to save AI response message', error as Error);
              // Don't fail the response - persistence errors shouldn't break the chat
            }
          } else {
            loggers.ai.warn('AI Chat API: No chatId or response message provided, skipping persistence');
          }

          // Reflect a user stop, including one that landed during inter-attempt backoff or
          // raced in after the loop broke (onAbort only fires while a streamText is live).
          // finish() is idempotent, so this is a no-op if onAbort already ran.
          lifecycle!.finish(agentRun?.terminalReason === 'aborted' || abortSignal.aborted);
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
    lifecycle?.finish(true);
    loggers.ai.error('AI Chat API Error', error as Error, {
      userId,
      chatId,
      provider: selectedProvider,
      model: selectedModel,
      responseTime: Date.now() - startTime
    });

    const usage = usagePromise ? await usagePromise : undefined;
    const steps = stepsPromise ? await stepsPromise : undefined;

    // Track AI usage even for errors using enhanced monitoring
    // Note: conversationId might not be available in error path, use chatId as fallback
    await AIMonitoring.trackUsage({
      userId: userId || 'unknown',
      provider: selectedProvider || 'unknown',
      model: selectedModel || 'unknown',
      source: 'chat',
      inputTokens: usage?.inputTokens ?? undefined,
      outputTokens: usage?.outputTokens ?? undefined,
      totalTokens:
        usage?.totalTokens ??
        ((usage?.inputTokens || 0) + (usage?.outputTokens || 0) || undefined),
      providerCostDollars: extractOpenRouterCostDollars(steps),
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
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_chat_settings', resourceId: 'get', details: { reason: 'auth_failed', method: 'GET' }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    // Get pageId from query params
    const url = new URL(request.url);
    const pageId = url.searchParams.get('pageId');
    
    // Get user's current provider settings
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    
    // Get page-specific settings if pageId provided
    let currentProvider = user?.currentAiProvider || 'pagespace';
    let currentModel = user?.currentAiModel || 'glm-4.5-air';
    
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
  // Define valid providers
  const validProviders = [
    'pagespace',
    'openrouter',
    'openrouter_free',
    'google',
    'openai',
    'anthropic',
    'xai',
    'ollama',
    'lmstudio',
    'glm'
  ];

  // Check if provider is valid
  if (!validProviders.includes(provider)) {
    return {
      valid: false,
      reason: `Invalid provider: ${provider}. Supported providers: ${validProviders.join(', ')}`
    };
  }

  // Validate model string format (basic sanity check)
  if (!model || typeof model !== 'string' || model.length > 100) {
    return {
      valid: false,
      reason: 'Invalid model format'
    };
  }

  // Check subscription requirements for pro models
  try {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const isAdminUser = user?.role === 'admin';
    if (isAdminOnlyProvider(provider) && !isAdminUser) {
      return {
        valid: false,
        reason: 'This provider is restricted to administrators'
      };
    }
    if (requiresProSubscription(provider, model, user?.subscriptionTier, isAdminUser)) {
      return {
        valid: false,
        reason: 'Pro or Business subscription required for this model'
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
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_chat_settings', resourceId: 'update', details: { reason: 'auth_failed', method: 'PATCH' }, riskScore: 0.5 });
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
    const canEdit = await canUserEditPage(auth.userId, sanitizedPageId);
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
