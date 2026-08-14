/**
 * The PAGE-AGENT chat turn — one of the two strategies behind the single
 * chat pipeline (`handle-chat-turn.ts`).
 *
 * Moved here verbatim from `app/api/ai/chat/route.ts`'s POST body (epic
 * "Agent-Session Single Source of Truth", Phase 5 — chat route consolidation).
 * The route file is now a thin surface that hands every POST to the shared
 * entry; the entry decides, from the CONVERSATION rather than the URL, which
 * strategy owns the turn. Nothing about this function's behaviour changed in
 * that move — its prologue (browser-session header, auth, the 25MB body guard,
 * the JSON parse) simply ran one frame earlier, in the entry, and arrives as
 * `ctx`.
 *
 * What stays page-specific, and why it could not be folded into the global
 * strategy, is enumerated in `handle-chat-turn.ts`'s divergence table.
 */

import { NextResponse } from 'next/server';
import {
  streamText,
  UIMessage,
  stepCountIs,
  hasToolCall,
  createUIMessageStream,
  type TextUIPart,
  type ToolSet,
} from 'ai';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, resolveProviderModel } from '@/lib/ai/core/ai-providers-config';
import { readAgentDispatchDepth } from '@/lib/ai/core/agent-dispatch-depth';
import { authorizePageConversation } from '@/lib/ai/core/authorize-page-conversation';
import { resolveGenerationAdmission } from '@/lib/ai/core/generation-admission';
import { mergeToolSets } from '@/lib/ai/core/tool-utils';
import { finishTool, FINISH_TOOL_NAME } from '@/lib/ai/tools/finish-tool';
import { askUserTools, ASK_USER_TOOL_NAME } from '@/lib/ai/tools/ask-user-tools';
import { canUseAskUser } from '@/lib/ai/core/ask-user-gating';
import {
  extractClientAskUserResults,
  applyAskUserResultsToPageMessage,
  dismissPendingAskUserForPageConversation,
} from '@/lib/ai/core/ask-user-resume';
import { MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { isMeteringExempt } from '@pagespace/lib/ai/model-defaults';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { makeOnStepFinishHandler } from '@/lib/ai/core/step-finish-handler';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { creditGateErrorResponse } from '@/lib/subscription/credit-gate-response';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { broadcastChatUserMessage } from '@/lib/websocket';
import { type StreamLifecycleHandle } from '@/lib/ai/core/stream-lifecycle';
import { pumpAndRespond } from '@/lib/ai/chat-pipeline/pump-and-respond';
import { startChatGeneration } from './start-chat-generation';
import { takeOverConversationStreams } from '@/lib/ai/core/stream-takeover';
import { startGenerationExclusive } from '@/lib/ai/core/start-generation-exclusive';
import { resolveMessageId } from '@/lib/ai/streams/resolveMessageId';
import { isMCPAuthResult, checkMCPPageScope, getAllowedDriveIds, isScopedMCPAuth, canPrincipalViewPage, canPrincipalEditPage, type AuthResult } from '@/lib/auth';

/**
 * Thrown when the conversation was still active at the ownership check far
 * above, but a concurrent History-delete committed sometime in the (long,
 * I/O-heavy) gap before the user-message persist below. Raised from inside the
 * short, tightly-scoped transaction that re-verifies immediately adjacent to
 * the write — see that call site's own comment.
 *
 * Shared with the global surface rather than redeclared: this file used to
 * carry its own class of the same name, so `instanceof` silently did not cross
 * between the two chat strategies and a caller catching one would miss the
 * other.
 */
import { ConversationHistoryDeletedError } from '@/lib/repositories/resolve-or-create-conversation';
// canUserViewPage stays user-level here: it gates mention-notification RECIPIENTS
// (other users), not the requesting principal.
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { createAIProvider, updateUserProviderSettings, createProviderErrorResponse, isProviderError, type ProviderRequest } from '@/lib/ai/core/provider-factory';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import { extractMessageContent, extractToolCalls, extractToolResults, sanitizeMessagesForModel, convertDbMessageToUIMessage } from '@/lib/ai/core/message-utils';
import { messageRepository } from '@/lib/repositories/message-repository';
import { buildAssistantPersistencePayload } from '@/lib/ai/core/persistAssistantParts';
import { processMentionsInMessage, buildMentionSystemPrompt } from '@/lib/ai/core/mention-processor';
import {
  buildCommandPromptSection,
  commandExecutionDataFromPlan,
  COMMAND_EXECUTION_PART_TYPE,
  isSoloBuiltinCommand,
  type CommandExecutionPlan,
} from '@/lib/ai/core/command-processor';
import { planCommandExecutions } from '@/lib/ai/core/command-resolver';
import { respondWithHelpAnswer } from '@/lib/ai/core/help-responder';
import { buildTimestampSystemPrompt } from '@/lib/ai/core/timestamp-utils';
import { getAgentContextDrives } from '@pagespace/lib/services/drive-agent-service';
import { buildLocationTurnPrompt } from '@/lib/ai/core/location-prompt';
import { buildActivePlanPrompt, getActivePlan } from '@/lib/ai/core/plan-binding';
import { resolveHomeDriveHint } from '@/lib/ai/core/home-drive-hint';
import {
  filterToolsForReadOnly,
  filterToolsForMcpScope,
  filterToolsForAgentAllowlist,
  filterToolsForDispatchCredentials,
  filterToolsForSandboxEnablement,
  filterToolsForSandboxTier,
} from '@/lib/ai/core/tool-filtering';
import { resolveSandboxToolEligibilityForConversation } from '@/lib/ai/core/sandbox-tool-eligibility';
import { shouldExposeImageGen } from '@/lib/ai/core/image-gen-access';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/core/model-capabilities';
import { getPageTreeContext } from '@/lib/ai/core/page-tree-context';
import { getModelCapabilities } from '@/lib/ai/core/model-capabilities';
import { guardReadPageToolForVision } from '@/lib/ai/tools/read-page-vision-output';
import { convertMCPToolsToAISDKSchemas, parseMCPToolName, sanitizeToolNamesForProvider } from '@/lib/ai/core/mcp-tool-converter';
import { getUserPersonalization } from '@/lib/ai/core/personalization-utils';
import { applyToolExposureMode, ALWAYS_UPFRONT_TOOLS } from '@/lib/ai/tools/tool-exposure';
import { buildBuiltinSkillCatalog, listEligibleSkills } from '@/lib/ai/core/skill-catalog';
import { loadUserCommandCatalog } from '@/lib/commands/command-catalog-loader';
import {
  buildAgentSystemPrompt,
  buildVolatileTurnContext,
  appendTurnContextToLastUserMessage,
  withCacheBreakpoints,
} from '@/lib/ai/core/prompt-assembly';
import { prepareHistoryForModel, finishModelRequest } from '@/lib/ai/core/context-assembly';
import { getAgentMemoryContext, buildAgentMemorySection } from '@/lib/ai/core/agent-memory';

import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { pages, drives } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
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
} from '@/lib/ai/core/stream-abort-registry';
import { runAgentWithRetry, AGENT_MAX_STEPS, isRunAborted, type RunAgentWithRetryResult } from '@/lib/ai/core/run-agent-with-retry';
import { resolveRequestContext } from '@/lib/ai/core/resolve-request-context';
import { locationContextToPageContext, pageContextToLocationContext } from '@/lib/ai/shared/buildPageContext';
import type { LocationContext } from '@/lib/ai/shared/chat-types';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import { validateUserMessageFileParts, hasFileParts } from '@/lib/ai/core/validate-image-parts';
import { hasVisionCapability } from '@/lib/ai/core/model-capabilities';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { deriveConversationTitle } from '@/lib/repositories/derive-conversation-title';


/**
 * Everything the shared entry (`handle-chat-turn.ts`) already resolved, handed
 * to this strategy so no header is re-read and no body re-parsed.
 */
export interface PageChatTurnContext {
  request: Request;
  /** The authenticated principal — session OR mcp, exactly as this surface always allowed. */
  auth: AuthResult;
  browserSessionId: string;
  /** The parsed JSON body, narrowed by this strategy to `PageChatRequestBody`. */
  body: unknown;
}


/**
 * The body `POST /api/ai/chat` accepts. Unchanged — lifted out of the
 * destructure's inline annotation only because the shared entry now parses the
 * JSON and this strategy narrows what it was handed.
 */
interface PageChatRequestBody {
  messages: UIMessage[];
  chatId?: string;
  /** Optional - will be auto-generated if not provided. */
  conversationId?: string;
  selectedProvider?: string;
  selectedModel?: string;
  /** MCP tool schemas from desktop (client-side execution). */
  mcpTools?: MCPTool[];
  /** Optional read-only mode toggle. */
  isReadOnly?: boolean;
  /** Optional web search toggle (defaults to false). */
  webSearchEnabled?: boolean;
  /** Optional image-generation toggle (defaults to false). */
  imageGenEnabled?: boolean;
  contextRef?: ContextRef;
  /** Deprecated: server-resolved from contextRef when present, kept 1+ release for old clients. */
  pageContext?: {
    pageId: string;
    pageTitle: string;
    pageType: string;
    pagePath: string;
    parentPath: string;
    breadcrumbs: string[];
    driveId?: string;
    driveName: string;
    driveSlug: string;
  };
}

export async function runPageChatTurn(ctx: PageChatTurnContext): Promise<Response> {
  const startTime = Date.now();
  let userId: string | undefined;
  let chatId: string | undefined;
  let conversationId: string | undefined;
  // Hoisted (assigned right after header validation below) so the terminal
  // save helper can stamp the repository's events with the originating pane.
  let browserSessionId = '';
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
    args: Omit<Parameters<typeof messageRepository.savePageMessage>[0], 'mentionNotify' | 'beforeSave' | 'triggeredBy'>,
  ): Promise<void> => {
    const mentionNotify = mentionNotifyFor(args.content);
    // The SAME atomic re-check the user's own message write uses, applied
    // here too: the earlier lock only covers the moment the user's message
    // was persisted, and model generation between then and THIS terminal
    // write can run for seconds — plenty of room for a History delete
    // (permitted the whole time; nothing else in this route blocks it mid-
    // generation) to land in between. Without this, the assistant's reply
    // persists as an ACTIVE message beneath a conversation already excluded
    // from every session listing — generation the user cancelled by
    // deleting the conversation, billed and answered into a transcript
    // they can no longer reach (review finding — chatgpt-codex-connector on
    // PR #2299). A deleted conversation silently drops the reply rather
    // than persisting it as orphaned; the provider call itself already
    // happened and is billed/tracked independently of this write via the
    // usual trackUsage path, which this does not touch — only what gets
    // WRITTEN to the (now-gone) conversation's transcript.
    const { saved: persisted } = await messageRepository.savePageMessage({
      ...args,
      ...(mentionNotify && { mentionNotify }),
      triggeredBy: userId ? { userId, browserSessionId } : undefined,
      // Runs inside the repository's transaction, before the message write.
      beforeSave: async (tx) => {
        const [row] = await tx
          .select({ isActive: conversations.isActive })
          .from(conversations)
          .where(eq(conversations.id, args.conversationId))
          .for('update')
          .limit(1);
        // `row` is undefined for a brand-new conversation whose eager
        // `createConversation()` call (above, before generation started)
        // failed — deliberately tolerated there (best-effort/non-fatal, see
        // that call site) so the user's own message still saves and
        // generation still proceeds. Treating "no row" the same as
        // "explicitly inactive" here would then silently drop the assistant's
        // reply too: the user sees it stream in, then loses it on refresh
        // while their own prompt remains (review finding — chatgpt-codex-
        // connector on PR #2299). Only skip when a row exists AND is
        // explicitly inactive (a real History-delete) — an absent row is not
        // that, it's the same tolerated gap the user message already crossed.
        return !(row && !row.isActive);
      },
    });
    if (persisted && mentionNotify) mentionNotified = true;
  };
  // Captured by the inner catch (createUIMessageStream construction failure) before it calls
  // lifecycle.finish().
  //
  // The reason this existed is GONE: finish() used to delete the multicast registry entry that
  // getBufferedParts() read from, so a fresh call afterwards always saw an empty buffer. The
  // lifecycle now closes over its own channel, and finishing a channel does not clear its ring,
  // so `getParts()` still returns the real content after finish(). Kept as belt-and-braces —
  // capturing at the earliest point is still the most faithful snapshot, and the cost is one
  // fold — but nothing depends on it any more.
  let bufferedPartsAtStreamError: Awaited<ReturnType<StreamLifecycleHandle['getParts']>> | undefined;
  // The credit-gate reservation for this request, released when usage is billed.
  let holdId: string | undefined;
  // True once the stream/error handler owns the hold's release. Any earlier
  // return/throw must release the hold (a pre-generation exit doesn't invoke the
  // model, so the reservation would otherwise sit until the reconcile cron sweeps it).
  let holdHandedOff = false;
  const permissionLogger = loggers.ai.child({ module: 'page-ai-permissions' });

  try {
    loggers.ai.info('AI Chat API: Starting request processing');

    // The browser-session header, authentication, the 25MB body guard and the
    // JSON parse all ran ONE FRAME EARLIER, in the shared entry both URL
    // surfaces call (`handle-chat-turn.ts`) — same checks, same order, same
    // responses; they arrive here already done rather than being repeated.
    const { request, auth: authResult } = ctx;
    browserSessionId = ctx.browserSessionId;
    userId = authResult.userId;
    loggers.ai.debug('AI Chat API: Authentication successful', { userId });

    // The parsed body, narrowed to the shape this strategy reads. The entry
    // hands it over as raw JSON (`Record<string, unknown>`); the annotated
    // destructure immediately below is, as before, the single declaration of
    // what `POST /api/ai/chat` accepts.
    const requestBody = ctx.body as PageChatRequestBody;
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
    }: PageChatRequestBody = requestBody;

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
    const resolvedLocation = contextRef
      ? await resolveRequestContext(authResult, contextRef, (denied) => {
          auditRequest(request, {
            eventType: 'authz.access.denied',
            userId,
            resourceType: denied.routeType === 'drive' ? 'drive' : 'page',
            resourceId: denied.routeType === 'drive' ? denied.driveId : denied.pageId,
            details: { reason: 'context_ref_denied', method: 'POST', chatId },
            riskScore: 0.3,
          });
        })
      : null;
    const pageContext = contextRef
      ? locationContextToPageContext(resolvedLocation)
      : legacyPageContext;

    // ONE normalized location for this turn, feeding both the model prompt and
    // the tool context. PageContext can't represent a drive-level location (it
    // requires a page), so deriving the prompt from it alone left the model told
    // "operating from the dashboard" on /dashboard/<drive>/<section> while tools
    // defaulted `driveId` to that very drive.
    const turnLocation: LocationContext | null = contextRef
      ? resolvedLocation
      : pageContextToLocationContext(legacyPageContext);

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

    // Extracted once and reused below (isSoloHelpRequest here, and the
    // user-message-save block further down) — extractMessageContent must run
    // at most once per request. userMessageForValidation and the userMessage
    // declared below are the same array element (messages[messages.length - 1]).
    const userMessageContent =
      userMessageForValidation?.role === 'user' ? extractMessageContent(userMessageForValidation) : '';

    // A message that is nothing but the /help chip answers directly from code
    // (see help-responder.ts) — no model call, so no credit hold is taken for
    // it. Computed this early so it can gate the credit gate below. /help
    // combined with other text is a real question and stays on the LLM path.
    const isSoloHelpRequest = isSoloBuiltinCommand(userMessageContent, 'help');

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
        // The ONE page-conversation decision (`authorize-page-conversation.ts`)
        // — ownership-or-shared AND belongs-to-this-page, plus the
        // history-deleted refusal. It used to be written out here and nowhere
        // else, which is how the consult route came to read other users'
        // transcripts on a shared agent page; extracting it is what lets both
        // surfaces run the same rule. See that module for why the page test is
        // a function of `type` and never of `contextId` alone.
        //
        // A history-deleted row (`conversations.isActive: false`) must never
        // accept a new message — the send would appear to succeed while the
        // canonical row stays excluded from both open and closed session
        // listings, leaving the new transcript unreachable after the stale
        // pane refreshes. This is reachable now that History-delete
        // deactivates the CANONICAL row (not just its messages) while a
        // conversation can still be open in another pane or browser tab
        // (review finding — chatgpt-codex-connector on PR #2296).
        const access = authorizePageConversation(existingConversation, { userId, pageId: chatId });
        if (!access.allowed) {
          if (access.reason === 'history_deleted') {
            loggers.ai.warn('AI Chat API: rejected send to a history-deleted conversation', {
              userId,
              requestConversationId,
            });
            return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
          }
          loggers.ai.warn('AI Chat API: rejected conversationId the caller may not write to', {
            userId,
            requestConversationId,
            ...access.detail,
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

    // Agent-dispatch depth (spawn_session/send_session): a worker's turn rides
    // this same route, and the header is how the chain depth survives the HTTP
    // hop so the depth cap (MAX_AGENT_DEPTH) still terminates A→B→C. Untrusted
    // by design and safe untrusted: forging it LOW yields the default any
    // client already has, forging it HIGH only restricts the forger.
    const agentDispatchDepth = readAgentDispatchDepth(request.headers);

    // Process @mentions in the user's message
    let mentionSystemPrompt = '';
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
    // A solo /help never reaches streamText (see isSoloHelpRequest below), so
    // it costs nothing — skip the gate entirely rather than take a hold that
    // would need special-cased release on the short-circuit path.
    if (!isMeteringExempt(gateProvider) && !isSoloHelpRequest) {
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
    // Runs AFTER the credit gate so a denied first prompt leaves no orphaned row.
    //
    // FAIL-CLOSED (was `.catch(() => {})` — carry-forward fix from PR #2344's
    // review). This used to be best-effort because nothing downstream strictly
    // needed the row: the message write creates it itself if missing, and a
    // failed broadcast gate just meant no broadcast. Migration 0250 changed
    // that — `ai_stream_sessions.conversationId` now has a real FK to
    // `conversations`, so a swallowed failure here no longer degrades
    // gracefully: it resurfaces ~900 lines later as a FK violation inside
    // `createStreamLifecycle`, INSIDE the advisory-lock closure, where it is
    // misread as lock-machinery failure and costs the user a confusing
    // mid-request 500 after the model may already have been billed. Surfacing
    // it here instead is both earlier and cheaper — the `finally` below
    // releases the credit hold on this early return, so nothing leaks.
    //
    // Only a THROW is fatal. `message_owner_conflict` is a returned status,
    // not an error: it means this conversation id already carries messages
    // owned by someone else, and the pre-existing behavior (proceed; the
    // message write's own in-transaction create/lock decides) is deliberately
    // preserved here rather than changed under cover of a fail-closed fix.
    try {
      const created = await conversationRepository.createConversation(conversationId, userId!, chatId);
      if (created === 'message_owner_conflict') {
        loggers.ai.warn('AI Chat API: conversation id already owned by another user\'s messages', {
          conversationId,
          userId,
        });
      }
    } catch (error) {
      loggers.ai.error('AI Chat API: Failed to ensure conversation row', error as Error, {
        conversationId,
        pageId: chatId,
      });
      return NextResponse.json(
        {
          error: 'Failed to start conversation. Please try again.',
          details: error instanceof Error ? error.message : 'Unknown database error',
        },
        { status: 500 },
      );
    }

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
        const messageContent = userMessageContent;

        // Process @mentions in the user message
        const processedMessage = processMentionsInMessage(messageContent);

        if (processedMessage.mentions.length > 0) {
          mentionSystemPrompt = buildMentionSystemPrompt(processedMessage.mentions);
          loggers.ai.info('AI Chat API: Found @mentions in user message', {
            mentionCount: processedMessage.mentions.length,
            pageIds: processedMessage.pageIds
          });
        }

        // Resolve every command token in the message (if any) with the
        // SENDER's permissions. The tokens stay in the saved content —
        // transcripts render each as a chip; only the system prompt gains
        // the injections.
        //
        // Skipped for a solo /help: it would resolve /help's dynamic
        // section (a DB read building the model-facing command list, via
        // resolveBuiltinInjection -> loadAvailableCommands) only for
        // commandSystemPrompt, which the solo-help short-circuit below
        // never sends to a model — respondWithHelpAnswer builds its own
        // "used" pill directly and does its own (single) command-list read.
        if (!isSoloHelpRequest) {
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
        }

        loggers.ai.debug('AI Chat API: Saving user message immediately', { id: messageId, contentLength: messageContent.length });

        // Atomic re-check immediately adjacent to the write: `existingConversation`
        // (if any) was read far above, but the credit-gate check, @mention
        // processing, and command resolution in between all do their own
        // unrelated I/O — plenty of room for a concurrent History-delete to commit
        // in that gap. A `SELECT ... FOR UPDATE` + the insert in ONE short
        // transaction (not wrapping any of the intervening work, which must never
        // run inside an open transaction) closes that window rather than trusting
        // the stale earlier read (review finding — chatgpt-codex-connector on PR
        // #2299).
        //
        // Unconditional — NOT gated on `existingConversation` (that snapshot
        // predates the eager createConversation() call a few lines up, and
        // stayed null for BOTH "genuinely no row anywhere yet" and "a LEGACY
        // conversation whose row that eager call just created": skipping the
        // lock for the second case let a concurrent History-delete land between
        // that create and this write with nothing to catch it — review finding,
        // round 11).
        await messageRepository.savePageMessage({
          messageId,
          pageId: chatId!,
          conversationId: conversationId!,
          userId: userId!,
          role: 'user',
          content: messageContent,
          toolCalls: undefined,
          toolResults: undefined,
          uiMessage: userMessage,
          triggeredBy: { userId: userId!, browserSessionId },
          // Runs inside the repository's transaction, immediately before the
          // message write — same statements, same lock order as before the
          // repository extraction.
          beforeSave: async (tx) => {
            const [row] = await tx
              .select({ isActive: conversations.isActive })
              .from(conversations)
              .where(eq(conversations.id, conversationId!))
              .for('update')
              .limit(1);

            if (row) {
              if (!row.isActive) throw new ConversationHistoryDeletedError();
              return { proceed: true };
            }
            // `FOR UPDATE` on zero rows locks nothing — if the eager
            // createConversation() call above hasn't landed a row yet (raced
            // with a concurrent request, or failed), there is nothing here
            // yet for the lock to serialize against: a concurrent create
            // (this request's own eager call, or another request's) plus a
            // History-delete could still interleave between here and the
            // message insert below, unguarded. Idempotently claim/create the
            // row IN THIS transaction instead — same create-then-select-the-
            // winner pattern resolveOrCreateConversation already uses for
            // the global route — so something is always actually locked
            // before the write proceeds (review finding — chatgpt-codex-
            // connector on PR #2299, round 12). Mirrors createConversation's
            // own insert shape/defaults exactly, since a caller landing here
            // supplied no `opts`.
            const [created] = await tx
              .insert(conversations)
              .values({
                id: conversationId!,
                userId: userId!,
                type: 'page',
                contextId: chatId!,
                isShared: false,
                title: null,
                updatedAt: new Date(),
              })
              .onConflictDoNothing()
              .returning({ isActive: conversations.isActive });

            if (created) {
              if (!created.isActive) throw new ConversationHistoryDeletedError();
              // The repository emits `conversation:created` after commit.
              return { proceed: true, conversationCreated: true };
            }
            // A concurrent insert won the race — re-select, locked, same
            // reasoning as the initial SELECT above.
            const [winner] = await tx
              .select({ isActive: conversations.isActive })
              .from(conversations)
              .where(eq(conversations.id, conversationId!))
              .for('update')
              .limit(1);
            if (!winner?.isActive) throw new ConversationHistoryDeletedError();
            return { proceed: true };
          },
        });

        // Fire-and-forget: title derivation must never fail or delay the chat
        // response, matching how createConversation above is treated as
        // non-fatal. existingConversation is always populated for a session's
        // conversation (its row is created before the first message ever
        // reaches this route) — the null check guards the non-session path.
        // A file/image-only first message derives an empty title; skip the
        // write so a later textual message still finds title IS NULL and can
        // title the conversation (autoTitleConversation only fills nulls).
        if (existingConversation) {
          const derivedTitle = deriveConversationTitle(messageContent);
          if (derivedTitle.length > 0) {
            conversationRepository
              .autoTitleConversation(existingConversation.id, derivedTitle)
              .catch(() => {});
          }
        }

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
        if (error instanceof ConversationHistoryDeletedError) {
          return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
        }
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

    // The user's /help message is already durably saved above (same generic
    // transaction as any other message) — answer it directly from code and
    // return before any of the provider/history/lifecycle machinery below
    // runs. No streamText, no credit hold (skipped above). It still takes
    // the SAME per-conversation takeover every other send does (review
    // finding — chatgpt-codex-connector, PR #2329): without it, a solo
    // /help sent from a second tab while another turn is generating would
    // land alongside that turn instead of taking it over, unlike every
    // other message.
    if (isSoloHelpRequest) {
      await startGenerationExclusive({
        conversationId: conversationId!,
        run: () => takeOverConversationStreams({ conversationId: conversationId!, channelId: chatId! }),
      });

      // Broadcast the user's own /help message the same way (and under the
      // same isShared gate) a real turn does, so collaborators watching a
      // shared conversation see the chip without a refetch (review finding
      // — chatgpt-codex-connector, PR #2329). The assistant reply itself
      // does not get the AI-stream-start/complete broadcast a real turn
      // gets — replicating that multiplayer live-stream protocol for an
      // already-complete synthetic reply risks destabilizing it for every
      // OTHER conversation; collaborators see the reply on next refetch,
      // same as the already-documented new-conversation-sidebar gap.
      if (existingConversation?.isShared === true) {
        broadcastChatUserMessage({
          message: userMessage,
          pageId: chatId!,
          conversationId: conversationId!,
          triggeredBy: { userId: userId!, displayName: user?.name ?? 'Someone', browserSessionId },
        }).catch(() => {});
      }

      return await respondWithHelpAnswer({
        senderId: userId!,
        driveId: page.driveId,
        originalMessages: messages,
        persist: (payload, messageId) =>
          saveTerminalAssistantMessage({
            messageId,
            pageId: chatId!,
            conversationId: conversationId!,
            userId: null,
            role: 'assistant',
            status: 'complete',
            ...payload,
          }),
      });
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
    
    // Echo the page's AI provider/model when the request picked a different one.
    //
    // FIRE-AND-FORGET, deliberately. This is an INCIDENTAL write — a
    // convenience echo of the model the user just chose in the picker — and it
    // used to be awaited with its `PageRevisionMismatchError` translated into a
    // 428/409 response. So a concurrent edit to the agent page (another tab
    // renaming it, a tool touching its config) could fail the whole chat turn
    // with a "revision conflict" the user cannot act on — and by this point
    // their message is already persisted, leaving a user turn with no reply.
    //
    // A conflict here means someone else's config write won, which is a fine
    // outcome for an echo: `PATCH /api/ai/chat` is the DELIBERATE path for this
    // mutation and keeps its optimistic-concurrency semantics. Losing the echo
    // costs a stale picker default until the next successful write; failing the
    // turn costs the conversation.
    if (selectedProvider && selectedModel && chatId) {
      if (selectedProvider !== page.aiProvider || selectedModel !== page.aiModel) {
        const configPageId = chatId;
        const expectedRevision = typeof page.revision === 'number' ? page.revision : undefined;
        void (async () => {
          const actorInfo = await getActorInfo(userId);
          await applyPageMutation({
            pageId: configPageId,
            operation: 'agent_config_update',
            updates: {
              aiProvider: selectedProvider,
              aiModel: selectedModel,
            },
            updatedFields: ['aiProvider', 'aiModel'],
            expectedRevision,
            context: {
              userId,
              actorEmail: actorInfo.actorEmail,
              actorDisplayName: actorInfo.actorDisplayName,
              resourceType: 'agent',
            },
          });
        })().catch((error) => {
          if (error instanceof PageRevisionMismatchError) {
            loggers.ai.debug('AI Chat API: agent config echo lost a revision race', {
              pageId: configPageId,
              currentRevision: error.currentRevision,
              expectedRevision: error.expectedRevision,
            });
            return;
          }
          loggers.ai.warn('AI Chat API: agent config echo failed', {
            pageId: configPageId,
            error: error instanceof Error ? error.message : 'unknown',
          });
        });
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

    // Step 1: Apply isReadOnly filter, and hide account-level-only tools
    // (e.g. create_drive) from drive-scoped MCP tokens' tool list. The session
    // + shell families ride `pageSpaceTools` itself (registered behind the
    // CODE_EXECUTION kill-switch alongside bash/git — see buildPageSpaceTools),
    // so no per-request registration happens here anymore: a conversation IS a
    // session, there is no binding to compose by.
    const baseTools = filterToolsForReadOnly(
      filterToolsForMcpScope(pageSpaceTools, isScopedMCPAuth(authResult)),
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

    // Step 3b: the per-agent sandbox switch AND the payer's tier eligibility.
    // An agent with sandboxEnabled off never sees the sandbox families
    // (bash/files, git+gh, sessions/shells) — independent of the allowlist,
    // which cannot re-grant them. A free-tier payer doesn't either: showing
    // tools that would hard-fail with tier_ineligible the moment they're
    // called is a UX bug, not a security concern (the env kill-switch and
    // per-call canRunCode remain the real security boundaries underneath;
    // this is agent configuration + UX, not authz). Short-circuited on
    // sandboxEnabled first — most agents never touch the sandbox at all, so
    // this skips the payer-tier DB round trip for the common case.
    const sandboxEnabled = Boolean(page.sandboxEnabled);
    // Bound-session first (review #2326): a page conversation hosted in a
    // driveless Global session is paid for by the SESSION's owner, not the
    // agent's drive owner — gate exposure on the payer provisioning will use.
    // An UNBOUND page conversation is not eligible at all (codex round 14):
    // the acquire path never lazily mints page conversations a session.
    const sandboxTierEligible = sandboxEnabled
      ? await resolveSandboxToolEligibilityForConversation(conversationId, 'page', userId)
      : false;
    filteredTools = filterToolsForSandboxEnablement(filteredTools, sandboxEnabled) as ToolSet;
    // The tier gate strips only the COMPUTE tools — a free payer keeps the
    // chat-only session family (sessions/chat are free on every plan).
    filteredTools = filterToolsForSandboxTier(filteredTools, sandboxTierEligible) as ToolSet;
    // spawn_session/send_session dispatch by forwarding the caller's browser
    // session cookie — an MCP-authenticated request (allowed on this route)
    // has none, so its dispatch could only ever refuse (codex round 9; same
    // posture as /api/v1 and non-interactive workflow runs).
    filteredTools = filterToolsForDispatchCredentials(filteredTools, !isMCPAuthResult(authResult)) as ToolSet;

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
    // Capability catalog: built-in skills (stable, appended to the system prompt
    // below) + the per-viewer user/drive command list (volatile, appended to the
    // last user message). Both gated on the agent actually having load_skill —
    // without the loader, advertising loadable capabilities is noise.
    const eligibleSkills = listEligibleSkills(allowedToolNames);
    const userCommandCatalog =
      eligibleSkills.length > 0 || allowedToolNames.includes('load_skill')
        ? await loadUserCommandCatalog(userId!, page.driveId ?? null, allowedToolNames)
        : { catalogPrompt: '', searchEntries: [] };
    const exposure = applyToolExposureMode(filteredTools, toolExposureMode, ALWAYS_UPFRONT_TOOLS, [
      ...eligibleSkills,
      ...userCommandCatalog.searchEntries,
    ]);
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

    // The system prompt itself is assembled once, below, by
    // `buildAgentSystemPrompt` — every input it needs is gathered first. Note
    // that "current page/drive" is turn-volatile: it is built separately as
    // `locationPrompt` and injected via buildVolatileTurnContext, NOT baked
    // into the system prompt, so that string stays byte-identical across turns.
    const hasTurnLocation = Boolean(turnLocation?.currentPage || turnLocation?.currentDrive);
    const locationHomeDriveId = await resolveHomeDriveHint(userId, hasTurnLocation, getAllowedDriveIds(authResult));

    const locationPrompt = buildLocationTurnPrompt(turnLocation ? {
      currentPage: turnLocation.currentPage,
      currentDrive: turnLocation.currentDrive,
      breadcrumbs: turnLocation.breadcrumbs,
      homeDriveId: locationHomeDriveId,
    } : { homeDriveId: locationHomeDriveId });

    // Skill catalog applies uniformly — including to custom-systemPrompt
    // agents, which opt out of buildInlineInstructions and would otherwise
    // carry load_skill with no idea what is loadable. It is capability
    // metadata (like toolDiscoveryPrompt), not behavioral instruction, and
    // varies only with the agent's tool configuration — stable per
    // conversation, so it belongs in the cache-stable prompt, never the
    // volatile block.
    const skillCatalogPrompt = buildBuiltinSkillCatalog(allowedToolNames);

    // Active plan pointer. Same volatility class as the skill catalog above and
    // as Agent Memory: it changes only when the agent calls set_plan/clear_plan,
    // never on navigation, so it is cache-stable per conversation. It has to be
    // in the stable prompt rather than the volatile block — the compaction
    // summary is lossy, and this pointer is precisely what the agent needs
    // after a summary.
    // Scoped MCP/OAuth tokens reach this turn too, and a plan can be bound to a
    // page in ANOTHER drive — so the principal-aware check is required here. A
    // user-level check would leak an out-of-scope plan's title and id to a token
    // that may not reach that drive.
    const activePlanPrompt = buildActivePlanPrompt(
      await getActivePlan(conversationId, userId, (pageId) =>
        canPrincipalViewPage(authResult, pageId),
      ),
    );


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

    // One assembly, shared with the Global Assistant and with voice — see
    // `buildAgentSystemPrompt`. A custom systemPrompt is a blank slate: it
    // skips the default persona and the workspace-knowledge block, but not the
    // capability metadata.
    const systemPrompt = buildAgentSystemPrompt({
      surface: 'page',
      readOnly: readOnlyMode,
      personalization,
      allowedToolNames,
      skillCatalog: skillCatalogPrompt,
      activePlan: activePlanPrompt,
      pageTree: pageTreePrompt,
      customSystemPrompt,
      drivePromptPrefix,
      memberDriveContextPrefix,
      agentMemory: agentMemoryPrompt,
      toolDiscovery: toolDiscoveryPrompt,
    });

    loggers.ai.debug('AI Chat API: Loading conversation history', {
      pageId: chatId
    });

    // Join the ask_user resume/dismiss write (if any) before loading history,
    // so this turn's model context reflects it — fired early above to
    // overlap with the independent setup between there and here.
    if (askUserSyncPromise) await askUserSyncPromise;

    const pageId = chatId as string;
    // Reads the UNIFIED `messages` table (epic "Agent-Session Single Source of
    // Truth", Phase 4 / D6 — reader cutover). Same rows, same order, same page
    // scope: the repository's page predicate is the join through
    // `conversations.contextId`, which is what `chat_messages.pageId` became.
    // `chat_messages` was DROPPED by migration 0253 — there is no dual write
    // and no revert path.
    //
    // Exclude 'streaming' placeholders — this load is the model-context source AND the
    // compaction source (prepareHistoryForModel below), so a placeholder here would both
    // poison this job's own turn (it hasn't finished writing yet) and risk being silently
    // summarized into a durable compaction. 'interrupted' rows stay included — they are
    // terminal, real partial output. See Server Stream Durability epic PR 2.
    const dbMessages = await messageRepository.getPageConversationMessages(pageId, conversationId);

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
      systemPrompt: systemPrompt,
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
      // LEGACY page-room broadcast, transitional (Agent-Session SSoT epic
      // Phase 2): the AUTHORITATIVE `conversation:message_created` already
      // went out unconditionally to the `conv:<id>` room from
      // messageRepository.savePageMessage — room membership is the authz
      // there, so the route no longer decides whether the durable event
      // broadcasts. This page-room `chat:user_message` mirror stays for old
      // clients and MUST keep its isShared gate while it lives: the page
      // room contains members with no access to private conversations, so
      // ungating it would widen the audience (the exact invariant the
      // Phase 2 security test pins). It is deleted with the other legacy
      // chat:* events in the client-cutover PR.
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

    // Per-conversation in-flight guard, stream lifecycle and the 'streaming'
    // placeholder — SHARED with the global-assistant strategy
    // (`start-chat-generation.ts`), which is where the takeover/lock/placeholder
    // reasoning now lives. The only page-specific inputs are the channel (the
    // agent page) and the placeholder's page scope.
    lifecycle = await startChatGeneration({
      conversationId: conversationId!,
      channelId: chatId!,
      messageId: serverAssistantMessageId!,
      userId: userId!,
      displayName,
      browserSessionId,
      streamId,
      isShared: isConversationShared,
      scope: { kind: 'page', pageId: chatId! },
    });

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
      const sdkStream = createUIMessageStream({
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
                commandCatalogPrompt: userCommandCatalog.catalogPrompt,
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
              system: systemPrompt,
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
                // Same normalized location the model prompt was built from, so
                // the two can never disagree about which workspace is in view.
                locationContext: turnLocation ? {
                  currentPage: turnLocation.currentPage ?? undefined,
                  currentDrive: turnLocation.currentDrive ?? undefined,
                  breadcrumbs: turnLocation.breadcrumbs,
                } : undefined,
                // Turn-start snapshot of the agent's working page — tools that
                // shift focus (e.g. create_page) mutate this in place so later
                // tool calls in the same turn track the agent's own actions
                // rather than staying pinned to the turn-start snapshot. Derived
                // from the same turnLocation as everything else above, so there
                // is exactly one answer to "where is the user" in this route.
                currentWorkingPage: turnLocation?.currentPage ? {
                  id: turnLocation.currentPage.id,
                  title: turnLocation.currentPage.title,
                  type: turnLocation.currentPage.type,
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
                // How deep in an agent-dispatch chain this turn already runs —
                // 0 for a direct user request, N for a worker turn dispatched
                // by spawn_session/send_session (the X-Agent-Dispatch-Depth
                // header parsed above). The session tools' depth cap reads it.
                agentCallDepth: agentDispatchDepth,
              }, // Pass userId, timezone, AI context, location context, model capabilities, and chat source to tools
              maxRetries: 20, // Increase from default 2 to 20 for better handling of rate limits
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
            const bufferedParts = await lifecycle!.getParts();
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
              // Deliberately still pageContext, NOT turnLocation: usage is
              // attributed to the drive of the PAGE in view, and turnLocation
              // also carries a drive on drive-level routes where no page is
              // open. Switching would start attributing spend to a drive this
              // metric never counted. The `|| undefined` keeps an empty-string
              // driveId reading as "no drive".
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
        toUIMessageStreamResponse: () =>
          pumpAndRespond({ sdkStream, lifecycle: lifecycle!, streamId, request, channelId: chatId!, conversationId: conversationId! }),
      };
    } catch (streamError) {
      removeStream({ streamId });
      // Captured BEFORE finish() for the same reason as the outer catch below — this inner
      // catch's own finish() call would otherwise clear the buffer before the outer catch's
      // cleanup ever gets a chance to read it.
      bufferedPartsAtStreamError = await lifecycle.getParts();
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
    // Prefers the inner catch's earlier capture when set. That preference used to be load-
    // bearing (finish() cleared the registry backing the old getBufferedParts, so a fresh call
    // here saw [] for exactly the createUIMessageStream-threw case this cleanup exists for);
    // it is now merely the more faithful of two working snapshots, since a finished channel
    // keeps its ring.
    const bufferedPartsAtError = bufferedPartsAtStreamError ?? (lifecycle ? await lifecycle.getParts() : []);
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
