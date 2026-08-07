/**
 * The GLOBAL-ASSISTANT chat turn — the second of the two strategies behind the
 * single chat pipeline (`handle-chat-turn.ts`).
 *
 * Moved here verbatim from `app/api/ai/global/[id]/messages/route.ts`'s POST
 * body (epic "Agent-Session Single Source of Truth", Phase 5 — chat route
 * consolidation). Its prologue (browser-session header, auth, the 25MB body
 * guard, the JSON parse) now runs one frame earlier, in the shared entry, and
 * arrives as `ctx`; nothing else about the turn changed.
 *
 * Why this is still a strategy of its own rather than a merged function: the
 * divergence table in `handle-chat-turn.ts`.
 */

import { NextResponse } from 'next/server';
import { streamText, stepCountIs, hasToolCall, UIMessage, createUIMessageStream, createUIMessageStreamResponse, type ToolSet } from 'ai';
import type { convertToModelMessages } from 'ai';
import { finishTool, FINISH_TOOL_NAME } from '@/lib/ai/tools/finish-tool';
import { askUserTools, ASK_USER_TOOL_NAME } from '@/lib/ai/tools/ask-user-tools';
import { resolveMessageId } from '@/lib/ai/streams/resolveMessageId';
import { canUseAskUser } from '@/lib/ai/core/ask-user-gating';
import { readAgentDispatchDepth } from '@/lib/ai/core/agent-dispatch-depth';
import { ASK_USER_SECTION, buildGlobalAssistantInstructions } from '@/lib/ai/core/inline-instructions';
import { buildLocationTurnPrompt } from '@/lib/ai/core/location-prompt';
import { buildActivePlanPrompt, getActivePlan } from '@/lib/ai/core/plan-binding';
import { resolveHomeDriveHint } from '@/lib/ai/core/home-drive-hint';
import {
  extractClientAskUserResults,
  applyAskUserResultsToGlobalMessage,
  dismissPendingAskUserForGlobalConversation,
} from '@/lib/ai/core/ask-user-resume';
import { mergeToolSets } from '@/lib/ai/core/tool-utils';
import { requiresProSubscription, createSubscriptionRequiredResponse, createAdminRestrictedResponse } from '@/lib/subscription/rate-limit-middleware';
import { ADMIN_ONLY_PROVIDERS, resolveProviderModel } from '@/lib/ai/core/ai-providers-config';
import { MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { isMeteringExempt } from '@pagespace/lib/ai/model-defaults';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { creditGateErrorResponse } from '@/lib/subscription/credit-gate-response';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { broadcastChatUserMessage } from '@/lib/websocket';
import { broadcastGlobalConversationAdded } from '@/lib/websocket/socket-utils';
import { type StreamLifecycleHandle } from '@/lib/ai/core/stream-lifecycle';
import { startChatGeneration } from './start-chat-generation';
import { takeOverConversationStreams } from '@/lib/ai/core/stream-takeover';
import { startGenerationExclusive } from '@/lib/ai/core/start-generation-exclusive';
import { chunkToPart } from '@/lib/ai/streams/chunkToPart';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import type { AuthResult } from '@/lib/auth';
import { createAIProvider, updateUserProviderSettings, createProviderErrorResponse, isProviderError, type ProviderRequest } from '@/lib/ai/core/provider-factory';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import { extractMessageContent, extractToolCalls, extractToolResults, sanitizeMessagesForModel, convertGlobalAssistantMessageToUIMessage } from '@/lib/ai/core/message-utils';
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
import { buildSystemPrompt, buildNonCoreToolNamesPrompt, TOOL_DISCOVERY_PROMPT } from '@/lib/ai/core/system-prompt';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { buildAgentAwarenessPrompt } from '@/lib/ai/core/agent-awareness';
import { filterToolsForReadOnly, filterToolsForWebSearch, filterToolsForImageGen, filterToolsForSandboxTier } from '@/lib/ai/core/tool-filtering';
import { resolveSandboxToolEligibilityForConversation } from '@/lib/ai/core/sandbox-tool-eligibility';
import { shouldExposeImageGen } from '@/lib/ai/core/image-gen-access';
import { getPageTreeContext, getDriveListSummary } from '@/lib/ai/core/page-tree-context';
import { getModelCapabilities, DEFAULT_IMAGE_MODEL } from '@/lib/ai/core/model-capabilities';
import { convertMCPToolsToAISDKSchemas, parseMCPToolName, sanitizeToolNamesForProvider } from '@/lib/ai/core/mcp-tool-converter';
import { getUserPersonalization, getUserTimezone } from '@/lib/ai/core/personalization-utils';
import { splitToolsForExposure, excludeAlwaysUpfront, ALWAYS_UPFRONT_TOOLS } from '@/lib/ai/tools/tool-exposure';
import { createExecuteTool } from '@/lib/ai/tools/execute-tool';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { drives } from '@pagespace/db/schema/core'
import { users } from '@pagespace/db/schema/auth';
import { decryptField } from '@pagespace/lib/encryption/field-crypto';
import { conversations } from '@pagespace/db/schema/conversations';
import { userProfiles } from '@pagespace/db/schema/members';
import { createId } from '@paralleldrive/cuid2';
import { getMCPBridge } from '@/lib/mcp';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskIdentifier } from '@/lib/logging/mask';
import type { MCPTool } from '@/types/mcp';
import type { LocationContext } from '@/lib/ai/shared/chat-types';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import { AIMonitoring, extractOpenRouterCostDollars, extractOpenRouterGenerationIds } from '@pagespace/lib/monitoring/ai-monitoring';
import { calculateTotalContextSize } from '@pagespace/lib/monitoring/ai-context-calculator';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import {
  attachStreamFinisher,
  createStreamAbortController,
  removeStream,
  STREAM_ID_HEADER,
} from '@/lib/ai/core/stream-abort-registry';
import { runAgentWithRetry, AGENT_MAX_STEPS, isRunAborted, type RunAgentWithRetryResult } from '@/lib/ai/core/run-agent-with-retry';
import { resolveRequestContext } from '@/lib/ai/core/resolve-request-context';
import { validateUserMessageFileParts, hasFileParts } from '@/lib/ai/core/validate-image-parts';
import { hasVisionCapability } from '@/lib/ai/core/model-capabilities';
import { guardReadPageToolForVision } from '@/lib/ai/tools/read-page-vision-output';
import { createToolSearchTool } from '@/lib/ai/tools/tool-search-tool';
import { buildBuiltinSkillCatalog, listEligibleSkills } from '@/lib/ai/core/skill-catalog';
import { loadUserCommandCatalog } from '@/lib/commands/command-catalog-loader';
import {
  buildVolatileTurnContext,
  appendTurnContextToLastUserMessage,
  withCacheBreakpoints,
} from '@/lib/ai/core/prompt-assembly';
import { prepareHistoryForModel, finishModelRequest } from '@/lib/ai/core/context-assembly';
import {
  resolveOrCreateConversation,
  ConversationOwnershipError,
  ConversationHistoryDeletedError,
} from '@/lib/repositories/resolve-or-create-conversation';
import { deriveConversationTitle } from '@/lib/repositories/derive-conversation-title';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';


/**
 * Everything the shared entry (`handle-chat-turn.ts`) already resolved, handed
 * to this strategy so no header is re-read and no body re-parsed.
 */
export interface GlobalChatTurnContext {
  request: Request;
  /**
   * The authenticated principal. Session-only, on BOTH surfaces: the
   * `/api/ai/global/...` URL authenticates session-only as it always did, and
   * the entry refuses to route an MCP principal into this strategy from the
   * `/api/ai/chat` surface (see `handle-chat-turn.ts`) — an MCP token has never
   * been able to drive the global assistant and still cannot.
   */
  auth: AuthResult;
  browserSessionId: string;
  /** The parsed JSON body, narrowed by this strategy to `GlobalChatRequestBody`. */
  body: unknown;
  /**
   * The `[id]` URL segment when the caller came in through the global URL —
   * the fallback for callers that send no `conversationId` in the body. Absent
   * on the `/api/ai/chat` surface, where the body is the only source.
   */
  urlConversationId?: string;
}

/**
 * The display name that rides realtime broadcast `triggeredBy` payloads:
 * the profile displayName if set, else the account name (decrypted at the
 * edge — GDPR #965), else 'Someone'. Shared by the main generation flow and
 * the solo-/help short-circuit so the two can't drift.
 */
async function resolveDisplayName(userId: string): Promise<string> {
  const [authUserResult, profileResult] = await Promise.allSettled([
    db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1),
    db.select({ displayName: userProfiles.displayName }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1),
  ]);
  const authUserNameRaw = authUserResult.status === 'fulfilled' ? authUserResult.value[0]?.name ?? null : null;
  const authUserName = await decryptField(authUserNameRaw);
  const profileDisplayName = profileResult.status === 'fulfilled' ? profileResult.value[0]?.displayName ?? null : null;
  return profileDisplayName ?? authUserName ?? 'Someone';
}


/**
 * The body `POST /api/ai/global/[id]/messages` accepts. Unchanged — written out
 * as a type only because the shared entry now parses the JSON and this strategy
 * narrows what it was handed.
 */
interface GlobalChatRequestBody {
  messages: UIMessage[];
  /**
   * The client's current identity state. It — not the URL segment — determines
   * where the message lands; the segment is only a fallback for callers that
   * don't send one.
   */
  conversationId?: string;
  selectedProvider?: string;
  selectedModel?: string;
  /** Deprecated: server-resolved from contextRef when present, kept 1+ release for old clients. */
  locationContext?: LocationContext | null;
  contextRef?: ContextRef;
  isReadOnly?: boolean;
  webSearchEnabled?: boolean;
  imageGenEnabled?: boolean;
  showPageTree?: boolean;
  mcpTools?: MCPTool[];
}

export async function runGlobalChatTurn(ctx: GlobalChatTurnContext): Promise<Response> {
  const startTime = Date.now();
  let lifecycle: StreamLifecycleHandle | undefined;
  let activeStreamId: string | undefined;
  // Set once the assistant placeholder row has received a terminal write (onFinish). The outer
  // catch's best-effort cleanup below must not fire once this is true — it would otherwise
  // downgrade an already-'complete'/'interrupted' row if something threw AFTER a successful
  // persist but before the response was returned. See Server Stream Durability epic PR 2 —
  // Codex review: a stream stopped before any content must not leave the placeholder stuck at
  // 'streaming' forever (excluded from reads, 409s on edit/delete).
  let assistantMessagePersisted = false;
  // Mirrors {conversationId, serverAssistantMessageId, userId} once all three are known
  // (inside the main try, so the originals stay block-scoped `const`s) — purely so the outer
  // catch's best-effort cleanup can reach them without a wider hoist of variables used in
  // dozens of places below.
  let cleanupContext: { conversationId: string; serverAssistantMessageId: string; userId: string } | undefined;
  // Hoisted (assigned right after header validation below) so the terminal
  // save helper can stamp the repository's events with the originating pane.
  let browserSessionId = '';
  // The credit-gate reservation for this request, released when usage is billed.
  let holdId: string | undefined;
  // Becomes true once the stream owns the hold (its onFinish will release it via
  // trackUsage). Until then, any early return/throw below must release the hold so a
  // pre-generation exit (auth/permission/provider/save failure) doesn't strand the
  // reservation against the user's balance + in-flight cap until the cron sweeps it.
  let holdHandedOff = false;
  // The SAME atomic re-check the user's own message write uses (this
  // route's own earlier `db.transaction` around the FIRST message), applied
  // here too: that lock only covers the moment the user's message was
  // persisted, and model generation between then and a TERMINAL write can
  // run for seconds — plenty of room for a History delete (permitted the
  // whole time; nothing else in this route blocks it mid-generation) to
  // land in between. Without this, the assistant's reply persists as an
  // ACTIVE message beneath a conversation already excluded from every
  // session listing — generation the user cancelled by deleting the
  // conversation, answered into a transcript they can no longer reach
  // (review finding — chatgpt-codex-connector on PR #2299, filed against
  // the page-agent chat route's identical gap; the same class of bug here
  // too). A deleted conversation silently drops the reply rather than
  // persisting it as orphaned; the provider call itself already happened
  // and is billed/tracked independently via the usual trackUsage path,
  // which this does not touch — only what gets WRITTEN to the (now-gone)
  // conversation's transcript. One shared choke point (all 3 terminal-write
  // sites below route through it) rather than three separate re-checks.
  const saveTerminalGlobalAssistantMessage = async (
    args: Omit<Parameters<typeof messageRepository.saveGlobalMessage>[0], 'beforeSave' | 'triggeredBy'>,
  ): Promise<boolean> => {
    const { saved } = await messageRepository.saveGlobalMessage({
      ...args,
      triggeredBy: { userId: args.userId, browserSessionId },
      beforeSave: async (tx) => {
        const [row] = await tx
          .select({ isActive: conversations.isActive })
          .from(conversations)
          .where(eq(conversations.id, args.conversationId))
          .for('update')
          .limit(1);
        return row?.isActive === true;
      },
    });
    return saved;
  };
  try {
    loggers.api.debug('Global Assistant Chat API: Starting request processing', {});

    // The browser-session header, authentication, the 25MB body guard and the
    // JSON parse all ran ONE FRAME EARLIER, in the shared entry both URL
    // surfaces call (`handle-chat-turn.ts`) — same checks, same order, same
    // responses; they arrive here already done rather than being repeated.
    const { request, auth } = ctx;
    browserSessionId = ctx.browserSessionId;
    const userId = auth.userId;
    const urlConversationId = ctx.urlConversationId;
    loggers.api.debug('Global Assistant Chat API: Authentication successful', { userId });

    // Agent-dispatch depth (spawn_session/send_session): a worker's turn rides
    // this same route; the header carries the chain depth across the HTTP hop
    // so the depth cap still terminates A→B→C. Safe untrusted — forging it low
    // is the default, forging it high only restricts the forger.
    const agentDispatchDepth = readAgentDispatchDepth(request.headers);

    // The parsed body, narrowed to the shape this strategy reads. The entry
    // hands it over as raw JSON; `GlobalChatRequestBody` is the same field set
    // the destructure below always declared.
    const requestBody = ctx.body as GlobalChatRequestBody;

    // The URL segment is baked into useChat's transport at construction and
    // never updates thereafter (its Chat instance is deliberately kept alive
    // across conversation switches to avoid clobbering messages — see
    // chat-config.ts). The body's conversationId reflects the client's
    // current identity state and is what determines where this message
    // actually lands; the URL segment is only a fallback for callers that
    // don't send one.
    //
    // `urlConversationId` is absent on the `/api/ai/chat` surface (there is no
    // segment to fall back to), where the body is therefore the only source —
    // and the entry only routes a turn here once that body id resolved to a
    // real global conversation, so the empty-string fallback is unreachable
    // from that direction. Kept rather than asserted because the fallback's
    // job on the global URL is unchanged.
    const conversationId: string =
      typeof requestBody.conversationId === 'string' && requestBody.conversationId.length > 0
        ? requestBody.conversationId
        : urlConversationId ?? '';

    loggers.api.debug('Global Assistant Chat API: Request body received', {
      messageCount: requestBody.messages?.length || 0,
      conversationId,
      selectedProvider: requestBody.selectedProvider,
      selectedModel: requestBody.selectedModel,
      hasLocationContext: !!requestBody.locationContext
    });

    // Resolve existing conversation or auto-create on first message (lazy creation).
    // Clients generate the ID locally; this is the point where the DB row is guaranteed.
    let conversation: typeof conversations.$inferSelect;
    let conversationIsNew = false;
    try {
      ({ conversation, isNew: conversationIsNew } = await resolveOrCreateConversation(userId, conversationId));
    } catch (e) {
      if (e instanceof ConversationOwnershipError || e instanceof ConversationHistoryDeletedError) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }
      throw e;
    }

    const {
      messages: requestMessages, // Used ONLY to extract new user message, NOT for conversation history
      selectedProvider,
      selectedModel,
      locationContext: legacyLocationContext, // Deprecated: server-resolved from contextRef when present, kept 1+ release for old clients
      contextRef,
      isReadOnly,
      webSearchEnabled,
      imageGenEnabled,
      showPageTree,
      mcpTools
    } = requestBody;

    // Validate required parameters
    if (!requestMessages || requestMessages.length === 0) {
      loggers.api.debug('Global Assistant Chat API: No messages provided', {});
      return NextResponse.json({ error: 'messages are required' }, { status: 400 });
    }

    loggers.api.debug('Global Assistant Chat API: Validation passed', { messageCount: requestMessages.length, conversationId });

    // Server-resolved (and permission-checked) from contextRef when the client sent
    // one — a contextRef pointing at a page/drive the caller cannot view resolves to
    // null here rather than trusting whatever the client claimed. Falls back to the
    // legacy client-computed locationContext only for old clients that never sent a
    // contextRef at all. Deferred until after the required-field check above so an
    // invalid request (no messages) fails fast without an extra DB round-trip.
    const locationContext = contextRef
      ? await resolveRequestContext(auth, contextRef, (denied) => {
          auditRequest(request, {
            eventType: 'authz.access.denied',
            userId,
            resourceType: denied.routeType === 'drive' ? 'drive' : 'page',
            resourceId: denied.routeType === 'drive' ? denied.driveId : denied.pageId,
            details: { reason: 'context_ref_denied', method: 'POST', conversationId },
            riskScore: 0.3,
          });
        })
      : legacyLocationContext;

    const userMessageForValidation = requestMessages[requestMessages.length - 1];

    // Extracted once and reused below (isSoloHelpRequest here, and the
    // user-message-save block further down) — extractMessageContent must run
    // at most once per request. userMessageForValidation and the userMessage
    // declared below are the same array element (requestMessages[requestMessages.length - 1]).
    const userMessageContent =
      userMessageForValidation?.role === 'user' ? extractMessageContent(userMessageForValidation) : '';

    // A message that is nothing but the /help chip answers directly from code
    // (see help-responder.ts) — no model call, so no credit hold is taken for
    // it. Computed this early so it can gate the credit gate below. /help
    // combined with other text is a real question and stays on the LLM path.
    const isSoloHelpRequest = isSoloBuiltinCommand(userMessageContent, 'help');

    // Image security validation — validate file parts in the user message
    if (userMessageForValidation?.role === 'user' && hasFileParts(userMessageForValidation)) {
      const imageValidation = validateUserMessageFileParts(userMessageForValidation);
      if (!imageValidation.valid) {
        loggers.api.warn('Global Assistant Chat API: Image validation failed', { error: imageValidation.error });
        return NextResponse.json({ error: imageValidation.error }, { status: 400 });
      }

      // Vision capability gate — reject images sent to non-vision models
      if (selectedModel && !hasVisionCapability(selectedModel)) {
        loggers.api.warn('Global Assistant Chat API: Images sent to non-vision model', { model: selectedModel });
        return NextResponse.json(
          { error: `The selected model "${selectedModel}" does not support image attachments. Please choose a vision-capable model.` },
          { status: 400 }
        );
      }
    }

    // Parse read-only mode early (needed for message saving)
    const readOnlyMode = isReadOnly === true;
    // Parse web search mode (defaults to false - disabled)
    const webSearchMode = webSearchEnabled === true;

    // Prepaid credit gate: block out-of-credits users BEFORE persisting their message
    // or invoking any model. Running it after the save would append the prompt to the
    // conversation and then 402, leaving an orphaned message that reappears (duplicated)
    // when the user tops up and retries — so this MUST precede the save below (mirrors
    // the page-chat route). Safe in billing-disabled deployments (returns unlimited) and
    // lazy-inits balances.
    let userSubscriptionTier: string | undefined;
    let userImageGenerationModel: string | null = null;
    {
      const [gateUser] = await db
        .select({
          subscriptionTier: users.subscriptionTier,
          currentAiProvider: users.currentAiProvider,
          currentAiModel: users.currentAiModel,
          imageGenerationModel: users.imageGenerationModel,
        })
        .from(users)
        .where(eq(users.id, userId));
      userSubscriptionTier = gateUser?.subscriptionTier ?? undefined;
      userImageGenerationModel = gateUser?.imageGenerationModel ?? null;
      // Metering-exempt providers (admin Z.ai Coder Plan) bill on a flat-rate external
      // subscription, so skip the credit gate entirely — no hold, no balance check —
      // and never debit at settle (see isMeteringExempt in trackAIUsage). Key the skip
      // on the RESOLVED provider (what actually runs): `glm` + an invalid model resolves
      // to the metered default, which must still be gated.
      const { provider: gateProvider } = resolveProviderModel(
        selectedProvider, selectedModel, gateUser?.currentAiProvider, gateUser?.currentAiModel);
      // A solo /help never reaches streamText (see isSoloHelpRequest below), so
      // it costs nothing — skip the gate entirely rather than take a hold that
      // would need special-cased release on the short-circuit path.
      if (!isMeteringExempt(gateProvider) && !isSoloHelpRequest) {
        const creditGate = await canConsumeAI(userId, (gateUser?.subscriptionTier ?? 'free') as SubscriptionTier, {
          estCostCents: estimateChatHoldCentsForModel(selectedModel),
          maxInFlight: MAX_CHAT_INFLIGHT,
        });
        if (!creditGate.allowed) {
          loggers.api.warn('Global Assistant Chat API: AI credit gate denied', {
            userId: maskIdentifier(userId),
            reason: creditGate.reason,
            conversationId,
          });
          return creditGateErrorResponse(creditGate.reason);
        }
        holdId = creditGate.holdId;
      }
    }

    // Process @mentions in the user's message
    let mentionSystemPrompt = '';
    let mentionedPageIds: string[] = [];
    // Universal Commands: resolved execution plans for every command token
    // present (zero or more). Each resolves independently and degrades,
    // never fails.
    let commandPlans: CommandExecutionPlan[] = [];
    let commandSystemPrompt = '';
    // Title resolved at save time (auto-generated from first user message when null).
    // Used in the broadcastGlobalConversationAdded call below so the sidebar
    // shows the real title rather than an empty string.
    let resolvedConversationTitle = conversation.title ?? '';

    // Save user's message immediately to database
    const userMessage = requestMessages[requestMessages.length - 1];
    // Set below (fire-early/await-late — see the ask_user branches ~90 lines
    // down) and joined right before the history load, so its DB round trip
    // overlaps with the independent setup in between instead of blocking it.
    let askUserSyncPromise: Promise<unknown> | undefined;
    if (userMessage && userMessage.role === 'user') {
      try {
        const messageId = resolveMessageId(userMessage.id);
        // Reassign so every downstream use of `userMessage` (the broadcast below,
        // any future read) agrees with what was actually persisted — see the
        // equivalent comment in apps/web/src/app/api/ai/chat/route.ts.
        userMessage.id = messageId;
        const messageContent = userMessageContent;
        
        // Process @mentions in the user message
        const processedMessage = processMentionsInMessage(messageContent);
        mentionedPageIds = processedMessage.pageIds;
        
        if (processedMessage.mentions.length > 0) {
          mentionSystemPrompt = buildMentionSystemPrompt(processedMessage.mentions);
          loggers.api.info('Global Assistant Chat API: Found @mentions in user message', {
            mentionCount: processedMessage.mentions.length,
            pageIds: mentionedPageIds
          });
        }

        // Resolve every command token in the message (if any) with the
        // SENDER's permissions. The tokens stay in the saved content; only
        // the system prompt gains the injections.
        // The global assistant's drive context is wherever the user is
        // browsing (the same locationContext.currentDrive the suggest picker
        // uses, so the picker and /help can't drift). The id is
        // client-supplied; the resolver membership-verifies it before any
        // drive commands are included. No drive → personal + built-ins only.
        //
        // Skipped for a solo /help — see the equivalent comment in
        // apps/web/src/app/api/ai/chat/route.ts.
        if (!isSoloHelpRequest) {
          commandPlans = await planCommandExecutions(messageContent, userId, {
            driveId: locationContext?.currentDrive?.id ?? null,
          });
          if (commandPlans.length > 0) {
            commandSystemPrompt = buildCommandPromptSection(commandPlans);
            for (const plan of commandPlans) {
              loggers.api.info('Global Assistant Chat API: Command resolution', {
                kind: plan.kind,
                ...(plan.kind === 'skip' ? { reason: plan.reason } : {}),
              });
            }
          }
        }

        loggers.api.debug('Global Assistant Chat API: Saving user message immediately', { id: messageId, contentLength: messageContent.length });
        
        // Atomic re-check immediately adjacent to the write: `resolveOrCreateConversation`
        // resolved this conversation as active well above, but the credit-gate check,
        // @mention processing, and command resolution in between all do their own
        // unrelated I/O — plenty of room for a concurrent History-delete to commit in
        // that gap. A `SELECT ... FOR UPDATE` + the insert in ONE short transaction (not
        // wrapping any of the intervening work, which must never run inside an open
        // transaction) closes that window rather than trusting the stale earlier read
        // (review finding — chatgpt-codex-connector and coderabbitai on PR #2299).
        await messageRepository.saveGlobalMessage({
          messageId,
          conversationId,
          userId,
          role: 'user',
          content: messageContent,
          toolCalls: undefined,
          toolResults: undefined,
          uiMessage: userMessage, // Pass UIMessage to preserve part ordering
          triggeredBy: { userId, browserSessionId },
          // Same atomic isActive re-check as before the repository
          // extraction, now inside the repository's own transaction.
          beforeSave: async (tx) => {
            const [row] = await tx
              .select({ isActive: conversations.isActive })
              .from(conversations)
              .where(eq(conversations.id, conversationId))
              .for('update')
              .limit(1);
            if (!row?.isActive) throw new ConversationHistoryDeletedError();
          },
        });

        auditRequest(request, { eventType: 'data.write', userId, resourceType: 'global_chat_message', resourceId: conversationId, details: {
          action: 'chat_message',
        } });

        // lastMessageAt now bumps inside the repository's save transaction
        // (with the rev counter); only the auto-title remains route-side.
        if (!conversation.title) {
          // Auto-generate title from first user message. Guarded in-SQL
          // (title IS NULL) + rev-bumped + emitted by the repository.
          const title = deriveConversationTitle(messageContent);
          resolvedConversationTitle = title;
          await globalConversationRepository.autoTitleConversation(conversationId, title);
        }

        loggers.api.debug('Global Assistant Chat API: User message saved to database', {});
      } catch (error) {
        if (error instanceof ConversationHistoryDeletedError) {
          return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
        }
        loggers.api.error('Global Assistant Chat API: Failed to save user message', error as Error);
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
      // independent setup in between instead of blocking it.
      askUserSyncPromise = dismissPendingAskUserForGlobalConversation({ conversationId }).catch((error) => {
        loggers.api.error('Global Assistant Chat API: Failed to dismiss pending ask_user question', error as Error);
      });
    } else if (userMessage?.role === 'assistant') {
      // Resume request: the client answered a pending ask_user question via
      // addToolResult (no new user message). Merge the answer into the
      // persisted assistant row so history load below picks it up. Same
      // fire-early/await-late pattern as the dismissal branch above.
      const clientResults = extractClientAskUserResults(userMessage);
      if (clientResults.length > 0) {
        askUserSyncPromise = applyAskUserResultsToGlobalMessage({
          messageId: userMessage.id,
          conversationId,
          results: clientResults,
        }).catch((error) => {
          loggers.api.error('Global Assistant Chat API: Failed to merge ask_user answer', error as Error);
        });
      }
    }

    // The user's /help message is already durably saved above (same generic
    // update as any other message) — answer it directly from code and return
    // before any of the provider/history/lifecycle machinery below runs. No
    // streamText, no credit hold (skipped above). It still takes the SAME
    // per-conversation takeover and realtime broadcasts every other send
    // gets (review finding — chatgpt-codex-connector, PR #2329): without
    // them, a solo /help from a second tab wouldn't take over an in-flight
    // generation on this conversation, and other open tabs would see
    // neither side of the turn until a refetch.
    if (isSoloHelpRequest) {
      const helpChannelId = globalChannelId(userId);
      const helpDisplayName = await resolveDisplayName(userId);

      if (conversationIsNew) {
        broadcastGlobalConversationAdded(helpChannelId, {
          conversation: {
            id: conversation.id,
            title: resolvedConversationTitle,
            type: conversation.type,
            createdAt: conversation.createdAt.toISOString(),
          },
          triggeredBy: { userId, displayName: helpDisplayName, browserSessionId },
        }).catch(() => {});
      }
      broadcastChatUserMessage({
        message: userMessage,
        pageId: helpChannelId,
        conversationId,
        triggeredBy: { userId, displayName: helpDisplayName, browserSessionId },
      }).catch(() => {});

      await startGenerationExclusive({
        conversationId,
        run: () => takeOverConversationStreams({ conversationId, channelId: helpChannelId }),
      });

      return await respondWithHelpAnswer({
        senderId: userId,
        driveId: locationContext?.currentDrive?.id ?? null,
        originalMessages: requestMessages,
        persist: (payload, messageId) =>
          saveTerminalGlobalAssistantMessage({
            messageId,
            conversationId,
            userId,
            role: 'assistant',
            status: 'complete',
            ...payload,
          }),
      });
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

    const { model, provider: currentProvider, modelName: currentModel } = providerResult;

    // Free users are limited to the free-model allowlist; defends against a model id
    // submitted directly in the request bypassing the settings-time gate.
    if (ADMIN_ONLY_PROVIDERS.has(currentProvider) && auth.role !== 'admin') {
      return createAdminRestrictedResponse();
    }
    if (requiresProSubscription(currentProvider, currentModel, userSubscriptionTier, auth.role === 'admin')) {
      loggers.api.warn('Global Assistant Chat API: paid plan required for model', {
        userId: maskIdentifier(userId),
        provider: currentProvider,
        model: currentModel,
      });
      return createSubscriptionRequiredResponse();
    }

    // Update user's current provider/model if changed
    await updateUserProviderSettings(userId, selectedProvider, selectedModel);

    loggers.api.debug('Global Assistant Chat API: Read-only mode', { isReadOnly: readOnlyMode });

    // DATABASE-FIRST ARCHITECTURE:
    // PageSpace uses database as the single source of truth for all messages.
    // We MUST read conversation history from database, not from client's request.
    // This ensures edited messages, multi-user changes, and any database updates
    // are reflected in the AI's context immediately.
    loggers.api.debug('Global Assistant Chat API: Loading conversation history from database', {
      conversationId
    });

    // Join the ask_user resume/dismiss write (if any) before loading history,
    // so this turn's model context reflects it — fired early above to
    // overlap with the independent setup between there and here.
    if (askUserSyncPromise) await askUserSyncPromise;

    // Read ALL active messages from database (source of truth). Exclude 'streaming'
    // placeholders — this load is the model-context source AND the compaction source, so a
    // placeholder here would both poison this job's own turn and risk being silently
    // summarized into a durable compaction. 'interrupted' rows stay included — they are
    // terminal, real partial output. See Server Stream Durability epic PR 2.
    // Through the repository since the message-table merge (epic
    // "Agent-Session Single Source of Truth", Phase 4 / D6): `messages` was
    // always the global leg, so no rows move — what changes is that the one
    // reader for durable messages is now the same seam the page chat uses, and
    // the query stops being spelled out a second time here.
    const dbMessages = await messageRepository.getMessagesByConversationId(conversationId);

    // Convert database messages to UI format
    const conversationHistory = await Promise.all(dbMessages.map(msg =>
      convertGlobalAssistantMessageToUIMessage({
        id: msg.id,
        conversationId: msg.conversationId,
        userId: msg.userId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        createdAt: msg.createdAt,
        isActive: msg.isActive,
        editedAt: msg.editedAt,
        status: msg.status,
      })
    ));

    loggers.api.debug('Global Assistant Chat API: Loaded conversation history from database', {
      messageCount: conversationHistory.length,
      conversationId
    });

    // Sanitize messages (removes tool parts without results, strips system role).
    // NOTE: We use database-loaded messages, NOT requestMessages from client.
    const sanitizedMessages = sanitizeMessagesForModel(conversationHistory);

    // modelMessages and stableBoundaryIndex are computed AFTER finalSystemPrompt
    // and finalTools are assembled (later in this handler), so that the compaction
    // token budget can count all three major cost components accurately.
    // The visual-content injection helper is also defined here for reuse below.
    const MAX_MESSAGES_WITH_IMAGES = 10;
    const injectVisualContent = (msgs: UIMessage[]): UIMessage[] =>
      msgs.map((msg: UIMessage) => {
        if (msg.role === 'assistant' && msg.parts) {
          const toolResults = msg.parts.filter((part) => {
            if (part && typeof part === 'object' && 'type' in part && part.type === 'tool-result') {
              const result = (part as { result?: unknown }).result;
              if (result && typeof result === 'object' && 'type' in result && 'imageDataUrl' in result) {
                return (result as { type: string }).type === 'visual_content';
              }
            }
            return false;
          });
          if (toolResults.length > 0) {
            const newParts = [...msg.parts];
            toolResults.forEach((toolResult) => {
              const result = (toolResult as { result?: { imageDataUrl?: string; title?: string } }).result;
              if (result?.imageDataUrl) {
                newParts.push({
                  type: 'data-visual-content' as const,
                  data: { imageDataUrl: result.imageDataUrl, title: result.title || 'Visual content' },
                });
                const mutableResult = result as { imageDataUrl?: string; title?: string };
                delete mutableResult.imageDataUrl;
              }
            });
            return { ...msg, parts: newParts };
          }
        }
        return msg;
      });

    // Fetch user personalization and timezone for AI system prompt injection
    const [personalization, userTimezone] = await Promise.all([
      getUserPersonalization(userId),
      getUserTimezone(userId),
    ]);
    if (personalization) {
      loggers.api.debug('Global Assistant: User personalization loaded', {
        hasPersonalization: true,
        hasBio: !!personalization.bio,
        hasWritingStyle: !!personalization.writingStyle,
        hasRules: !!personalization.rules,
      });
    }

    // Build system prompt. Note: "current page/drive" is turn-volatile — it's
    // built separately as `locationPrompt` below and injected via
    // buildVolatileTurnContext, NOT baked in here, so this string stays
    // byte-identical across turns regardless of where the user navigates.
    const baseSystemPrompt = buildSystemPrompt(
      readOnlyMode,
      personalization ?? undefined,
      isCodeExecutionEnabled()
    );

    const hasLocation = Boolean(locationContext?.currentPage || locationContext?.currentDrive);
    const locationHomeDriveId = await resolveHomeDriveHint(userId, hasLocation);

    const locationPrompt = buildLocationTurnPrompt(locationContext ? {
      currentPage: locationContext.currentPage,
      currentDrive: locationContext.currentDrive,
      breadcrumbs: locationContext.breadcrumbs,
      homeDriveId: locationHomeDriveId,
    } : { homeDriveId: locationHomeDriveId });

    // Build timestamp system prompt for temporal awareness (using user's timezone)
    const timestampSystemPrompt = buildTimestampSystemPrompt(userTimezone);

    // Fetch drive prompt if user is within a drive
    let drivePromptSection = '';
    if (locationContext?.currentDrive?.id) {
      try {
        const [drive] = await db
          .select({ drivePrompt: drives.drivePrompt })
          .from(drives)
          .where(eq(drives.id, locationContext.currentDrive.id))
          .limit(1);

        if (drive?.drivePrompt?.trim()) {
          drivePromptSection = `\n\n## DRIVE INSTRUCTIONS\n\nThe following custom instructions have been set for this drive by the drive owner:\n\n${drive.drivePrompt}`;
          loggers.api.debug('Global Assistant Chat API: Including drive prompt', {
            driveId: locationContext.currentDrive.id,
            promptLength: drive.drivePrompt.length
          });
        }
      } catch (error) {
        loggers.api.error('Global Assistant Chat API: Failed to fetch drive prompt', error as Error);
        // Continue without drive prompt on error
      }
    }

    // Add global assistant specific instructions (including tool discovery — only this route has tool_search).
    // Stable order: base → TOOL_DISCOVERY → global instructions → drivePrompt → agentAwareness → pageTree → nonCoreToolNames.
    // Volatile sections (timestamp/location/mention/command) are NOT concatenated here; they are
    // appended to the last user message at assembly time so the system prefix stays
    // byte-identical across turns and provider prefix caches are not invalidated —
    // including turns where only the user's current page/drive changed.
    // Workspace knowledge (page types, tasks, agents, automation, search,
    // mentions) comes from the SHARED inline-instructions sections appended
    // at finalSystemPrompt assembly below — this route previously carried a
    // bespoke copy that drifted (it claimed tasks create linked DOCUMENT
    // pages; they create TASK_LIST children). Only genuinely
    // global-assistant-specific guidance remains inline here.
    const systemPrompt = baseSystemPrompt + '\n\n' + TOOL_DISCOVERY_PROMPT + `

You are the Global Assistant for PageSpace - accessible from both the dashboard and sidebar.

SMART EXPLORATION RULES:
1. When in a drive context (see your current LOCATION context for the driveId) - ALWAYS explore it first:
   - ALWAYS use list_pages on the current drive when:
     • User asks about the drive, its contents, or what's available
     • User wants to create, write, or modify ANYTHING
     • User mentions something that MAY exist in the drive
     • User asks general questions about content or organization
     • You need to understand the workspace structure
   - Start with list_pages on the current drive BEFORE other actions
2. Context-first approach:
   - Default scope: current drive/location (see LOCATION context) is your primary workspace
   - Only explore OTHER drives when explicitly mentioned
   - When user says "here" or "this", they mean current context
   - If LOCATION context shows no drive, you're in the dashboard — use list_drives when you need to work across multiple workspaces; always check existing drives before suggesting new drive creation — never fall back to the Home drive as a guess
3. Efficient exploration pattern:
   - FIRST: list_pages on the current drive — omit driveId and it uses the drive in your LOCATION context
   - THEN: read specific pages as needed
   - ONLY IF NEEDED: explore other drives/workspaces
4. Proactive assistance:
   - Don't ask "what's in your drive" - use list_pages to discover
   - Suggest creating AI_CHAT and CHANNEL pages for organization
   - Be autonomous within current context

CONVERSATION TYPE: ${conversation.type.toUpperCase()}${conversation.contextId ? ` (Context: ${conversation.contextId})` : ''}` +
      (canUseAskUser({ role: auth.role }) ? `\n\n${ASK_USER_SECTION}` : '') +
      drivePromptSection;

    // The PAYER's sandbox eligibility for this Global Assistant turn —
    // derived from the conversation's BOUND SESSION, never the location
    // drive (review #2326, two rounds): an unbound global conversation gets
    // a DRIVELESS session on its first tool call (`ensureGlobalSandboxSession`
    // spawns `driveId: null` unconditionally), so this user is the payer
    // regardless of which drive they happen to be visiting — keying on the
    // location drive both advertised tools a free visitor's own session
    // could never fund AND hid tools a paid visitor's driveless session
    // funds fine. A conversation already bound to a session uses that
    // session's own coordinates, exactly as provisioning will. Without this,
    // a free-tier assistant advertised bash/git tools that always answer
    // tier_ineligible — and those git tool NAMES in `currentTools` then
    // suppressed the user's working GitHub OAuth integration tools.
    const sandboxTierEligible = await resolveSandboxToolEligibilityForConversation(
      conversation.id,
      'global',
      userId,
    );

    // Build agent awareness prompt - lists visible AI agents for consultation
    // `canDelegate` mirrors the session-tool gate: spawn_session registers
    // regardless of the CODE_EXECUTION kill-switch (the chat-only session
    // family is free conversation orchestration, see `buildPageSpaceTools`),
    // but `filterToolsForReadOnly` strips it as a write tool — and a prompt
    // that names a tool the model does not have makes it attempt delegation
    // that silently fails. The payer-tier filter does NOT remove the
    // chat-only session family (sessions are free on every plan), so tier is
    // deliberately not weighed here.
    const agentAwarenessPrompt = await buildAgentAwarenessPrompt(userId, {
      canDelegate: !readOnlyMode,
    });

    // Build page tree context if enabled
    let pageTreePrompt = '';
    if (showPageTree) {
      if (locationContext?.currentDrive?.id) {
        // In drive context: show full drive tree
        const treeContext = await getPageTreeContext(userId, {
          scope: 'drive',
          driveId: locationContext.currentDrive.id,
        });
        if (treeContext) {
          pageTreePrompt = `\n\n## WORKSPACE STRUCTURE\n\nHere is the complete workspace structure:\n\n${treeContext}`;
          loggers.api.debug('Global Assistant: Page tree context included', {
            driveId: locationContext.currentDrive.id,
            contextLength: treeContext.length
          });
        }
      } else {
        // Dashboard context: show drive list summary
        const driveSummary = await getDriveListSummary(userId);
        if (driveSummary) {
          pageTreePrompt = `\n\n## ACCESSIBLE WORKSPACES\n\n${driveSummary}`;
          loggers.api.debug('Global Assistant: Drive list summary included', {
            summaryLength: driveSummary.length
          });
        }
      }
    }

    // Full filtered tool set. NOT sent to model directly; used as dispatch map for
    // execute_tool and as tool_search catalog. The COMPUTE tools (bash/files,
    // git+gh, PTY shells — not the free chat-session family) are stripped for a tier-ineligible payer BEFORE
    // anything reads this set — including `resolveGlobalAssistantIntegrationTools`
    // below, whose sandbox-git-overlap suppression keys on these tool NAMES.
    const filteredAllTools = filterToolsForImageGen(
      filterToolsForWebSearch(
        filterToolsForReadOnly(
          filterToolsForSandboxTier(pageSpaceTools, sandboxTierEligible),
          readOnlyMode
        ),
        webSearchMode
      ),
      shouldExposeImageGen({
        imageGenEnabled: imageGenEnabled === true,
        isAdmin: auth.role === 'admin',
        hasToolDef: true,
      })
    ) as ToolSet;

    // Core tools (plus the always-upfront runtime toggles) go to the model with full
    // schemas; everything else is hidden from the model and reachable only via
    // execute_tool.
    const { coreTools, nonCoreTools } = splitToolsForExposure(filteredAllTools, ALWAYS_UPFRONT_TOOLS);

    // Capability catalog: built-in skills join the stable prompt; the
    // per-viewer command list rides the volatile turn context below. Both
    // feed tool_search's corpus so discovery has one search surface.
    const availableToolNames = Object.keys(filteredAllTools);
    const eligibleSkills = listEligibleSkills(availableToolNames);
    const userCommandCatalog = await loadUserCommandCatalog(
      userId,
      locationContext?.currentDrive?.id ?? null,
      availableToolNames
    );
    const skillCatalogPrompt = buildBuiltinSkillCatalog(availableToolNames);

    // Active plan pointer. Same volatility class as the skill catalog: it
    // changes only when the agent calls set_plan/clear_plan, never on
    // navigation, so it is cache-stable per conversation. It has to be here
    // rather than in the volatile block — the compaction summary is lossy, and
    // this pointer is precisely what the agent needs after a summary.
    const activePlanPrompt = buildActivePlanPrompt(await getActivePlan(conversationId, userId));

    const nonCoreToolNamesPrompt = buildNonCoreToolNamesPrompt(Object.keys(nonCoreTools));
    const finalSystemPrompt = systemPrompt
      + '\n' + buildGlobalAssistantInstructions(availableToolNames)
      + (agentAwarenessPrompt ? '\n\n' + agentAwarenessPrompt : '')
      + pageTreePrompt
      + (nonCoreToolNamesPrompt ? '\n\n' + nonCoreToolNamesPrompt : '')
      + skillCatalogPrompt
      + activePlanPrompt;

    let finalTools: ToolSet = {
      ...coreTools,
      tool_search: createToolSearchTool(
        excludeAlwaysUpfront(filteredAllTools, ALWAYS_UPFRONT_TOOLS),
        [...eligibleSkills, ...userCommandCatalog.searchEntries]
      ),
      execute_tool: createExecuteTool(nonCoreTools),
    };

    // Guard against a stale read_page tool-result (image bytes delivered on an
    // earlier turn when the model had vision) being re-embedded as an image when
    // history is re-converted for a model that no longer has vision.
    if (finalTools.read_page) {
      finalTools = {
        ...finalTools,
        read_page: guardReadPageToolForVision(finalTools.read_page, hasVisionCapability(currentModel)),
      };
    }

    loggers.api.debug('Global Assistant Chat API: Tool modes', {
      isReadOnly: readOnlyMode,
      webSearchEnabled: webSearchMode,
      totalTools: Object.keys(finalTools).length
    });

    // INTEGRATION TOOLS: Resolve and merge integration tools for global assistant
    try {
      const { resolveGlobalAssistantIntegrationTools } = await import('@/lib/ai/core/integration-tool-resolver');
      let currentDriveId = locationContext?.currentDrive?.id || null;
      let userDriveRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null = null;
      if (currentDriveId) {
        const access = await getDriveAccess(currentDriveId, userId);
        if (!access.isMember) {
          // User is not a member of this drive — do not resolve drive-scoped integrations
          currentDriveId = null;
        } else {
          userDriveRole = access.role;
        }
      }
      const integrationTools = await resolveGlobalAssistantIntegrationTools({
        userId,
        driveId: currentDriveId,
        userDriveRole,
        // filteredAllTools (not finalTools) carries raw tool names as top-level
        // keys — finalTools is always { ...coreTools, tool_search, execute_tool },
        // which never contains sandbox git/gh tool names directly.
        currentTools: filteredAllTools,
      });
      if (Object.keys(integrationTools).length > 0) {
        finalTools = mergeToolSets(finalTools, integrationTools);
        loggers.api.info('Global Assistant: Merged integration tools', {
          integrationToolCount: Object.keys(integrationTools).length,
          totalTools: Object.keys(finalTools).length,
        });
      }
    } catch (error) {
      loggers.api.error('Global Assistant: Failed to resolve integration tools', error as Error);
    }

    // Merge MCP tools if provided
    if (mcpTools && mcpTools.length > 0) {
      try {
        loggers.api.info('Global Assistant Chat API: Integrating MCP tools from desktop', {
          mcpToolCount: mcpTools.length,
          toolNames: mcpTools.map((t: MCPTool) => `mcp:${t.serverName}:${t.name}`),
          userId: maskIdentifier(userId),
          conversationId
        });

        // Convert MCP tools to AI SDK format
        const mcpToolSchemas = convertMCPToolsToAISDKSchemas(mcpTools);

        // Create execute functions that proxy to WebSocket bridge.
        // Sort keys so tool array order is deterministic across requests (only real config
        // changes — webSearch/readOnly/MCP/exposure-mode — may change the tool array).
        const mcpToolsWithExecute: Record<string, unknown> = {};
        for (const toolName of Object.keys(mcpToolSchemas).sort()) {
          const toolSchema = mcpToolSchemas[toolName];
          mcpToolsWithExecute[toolName] = {
            ...toolSchema,
            execute: async (args: Record<string, unknown>) => {
              // Parse tool name using shared parser (supports both mcp:server:tool and legacy mcp__server__tool)
              const parsed = parseMCPToolName(toolName);
              if (!parsed) {
                throw new Error(`Invalid MCP tool name format: ${toolName}`);
              }
              const { serverName, toolName: originalToolName } = parsed;

              loggers.api.debug('MCP Tool Execute: Calling tool via bridge', {
                toolName,
                serverName,
                originalToolName,
                userId: maskIdentifier(userId)
              });

              // executeTool returns Promise<unknown> - resolves with result or rejects with error
              const result = await getMCPBridge().executeTool(userId, serverName, originalToolName, args);
              return result;
            }
          };
        }

        // Merge MCP tools with PageSpace tools, then sanitize for provider compatibility
        // (many providers reject colons in tool names - sanitization converts mcp:server:tool to mcp__server__tool)
        finalTools = sanitizeToolNamesForProvider({ ...finalTools, ...mcpToolsWithExecute } as Record<string, ToolSet[string]>) as ToolSet;

        loggers.api.info('Global Assistant Chat API: Successfully merged MCP tools', {
          totalTools: Object.keys(finalTools).length,
          mcpTools: Object.keys(mcpToolSchemas).length,
          pageSpaceTools: Object.keys(finalTools).length - Object.keys(mcpToolSchemas).length
        });
      } catch (error) {
        loggers.api.error('Global Assistant Chat API: Failed to integrate MCP tools', error as Error, {
          userId: maskIdentifier(userId),
          conversationId
        });
        // Continue without MCP tools rather than failing the entire request
      }
    } else {
      loggers.api.debug('Global Assistant Chat API: No MCP tools provided in request', {
        userId: maskIdentifier(userId),
        conversationId
      });
    }

    // Always inject the finish tool so the model can signal task completion
    finalTools = { ...finalTools, ...finishTool } as ToolSet;

    // Interactive ask_user tool (execute-less, pauses the turn for user input).
    // Injected here like finish — deliberately NOT in filteredAllTools/nonCoreTools,
    // so it never enters the tool_search catalog or the execute_tool dispatch map
    // (execute_tool would crash on an execute-less tool, and the catalog is
    // visible to non-admins).
    if (canUseAskUser({ role: auth.role })) {
      finalTools = { ...finalTools, ...askUserTools } as ToolSet;
    }

    // Sanitize, compact, and elide via the unified seam.
    // finalSystemPrompt + finalTools are now known — pass for accurate token budgeting.
    // IIFE keeps the outputs const (each is assigned exactly once).
    const { modelMessages, stableBoundaryIndex, scheduleCompaction, contextMessagesForTracking } =
      await (async () => {
        const prepared = await prepareHistoryForModel({
          history: conversationHistory,
          conversationId,
          source: 'global',
          model: currentModel,
          provider: currentProvider,
          systemPrompt: finalSystemPrompt,
          tools: finalTools as Record<string, unknown>,
          user: { id: userId, role: auth.role ?? null },
        });

        // Limit visual-content injection to the last MAX_MESSAGES_WITH_IMAGES items;
        // the earlier head is kept intact so the full prepared context reaches the model.
        const visualCutoff = Math.max(0, prepared.messages.length - MAX_MESSAGES_WITH_IMAGES);
        const headMessages = prepared.messages.slice(0, visualCutoff);
        const recentTail = prepared.messages.slice(visualCutoff);
        const processedTail = [
          ...headMessages,
          ...injectVisualContent(recentTail),
        ] as Parameters<typeof convertToModelMessages>[0];

        // Post-compaction view for context tracking: summary (as a synthetic
        // UIMessage) + the exact processed tail that was sent to the model.
        // Using processedTail (not prepared.messages) ensures imageDataUrl stripping
        // and data-visual-content injection are reflected in the tracked byte count.
        const contextMessagesForTracking = prepared.summaryText
          ? [
              { role: 'user' as const, parts: [{ type: 'text' as const, text: prepared.summaryText }] },
              ...(processedTail as UIMessage[]),
            ]
          : (processedTail as UIMessage[]);

        const { modelMessages, stableBoundaryIndex } = await finishModelRequest({
          prepared,
          tail: processedTail,
          tools: finalTools,
        });

        return {
          modelMessages,
          stableBoundaryIndex,
          scheduleCompaction: prepared.scheduleCompaction,
          contextMessagesForTracking,
        };
      })();

    loggers.api.debug('Global Assistant Chat API: Starting streamText', { model: currentModel, isReadOnly: readOnlyMode });

    // Calculate context size BEFORE streaming (for real context window tracking).
    // Uses the post-compaction message set so the admin context viewer and
    // monitoring agree with what was actually sent to the model.
    const contextCalculation = calculateTotalContextSize({
      systemPrompt: finalSystemPrompt,
      messages: contextMessagesForTracking,
      tools: finalTools,
      model: currentModel,
      provider: currentProvider,
    });

    loggers.api.debug('Global Assistant Chat API: Context calculation', {
      contextSize: contextCalculation.totalTokens,
      messageCount: contextCalculation.messageCount,
      systemPromptTokens: contextCalculation.systemPromptTokens,
      toolTokens: contextCalculation.toolDefinitionTokens,
      wasTruncated: contextCalculation.wasTruncated,
    });

    const serverAssistantMessageId = createId();
    cleanupContext = { conversationId, serverAssistantMessageId, userId };

    const { streamId, signal: abortSignal, controller: abortController } = createStreamAbortController({ userId, messageId: serverAssistantMessageId });
    activeStreamId = streamId;

    const channelId = globalChannelId(userId);
    const displayName = await resolveDisplayName(userId);

    if (conversationIsNew) {
      broadcastGlobalConversationAdded(channelId, {
        conversation: {
          id: conversation.id,
          title: resolvedConversationTitle,
          type: conversation.type,
          createdAt: conversation.createdAt.toISOString(),
        },
        triggeredBy: { userId, displayName, browserSessionId },
      }).catch(() => {});
    }

    if (userMessage && userMessage.role === 'user') {
      broadcastChatUserMessage({
        message: userMessage,
        pageId: channelId,
        conversationId,
        triggeredBy: { userId, displayName, browserSessionId },
      }).catch(() => {});
    }

    // Per-conversation in-flight guard, stream lifecycle and the 'streaming'
    // placeholder — SHARED with the page-agent strategy
    // (`start-chat-generation.ts`). Without the guard the global assistant
    // happily starts a second generation on the same conversation — two agents,
    // two assistant rows, two bills. The takeover/lock/placeholder reasoning now
    // lives in that one module rather than in two copies.
    lifecycle = await startChatGeneration({
      conversationId,
      channelId,
      messageId: serverAssistantMessageId,
      userId,
      displayName,
      browserSessionId,
      streamId,
      isShared: conversation.isShared === true,
      scope: { kind: 'global', userId },
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

    // Outcome of the retry shell, shared from execute() to onFinish(). Carries the
    // summed usage/steps for billing plus the success flag, abort detection, and retry
    // observability — so no separate usage/steps promises are needed.
    let agentRun: RunAgentWithRetryResult | undefined;

    const stream = createUIMessageStream({
      originalMessages: sanitizedMessages, // full history — UI always sees all messages
      generateId: () => serverAssistantMessageId,
      execute: async ({ writer }) => {
        // Pre-aborted (#2028 item 1, see StreamLifecycleHandle.preAborted) — nothing past this
        // point can ever reach the model. Skip straight to onFinish rather than relying on the
        // already-aborted signal to short-circuit streamText's underlying fetch.
        if (lifecycle!.preAborted) return;

        // Execution feedback (UX spec §7): announce one command indicator
        // per resolved plan as the first parts of the assistant message, in
        // the order the chips appeared; persisted via onFinish.
        commandPlans.forEach((plan, index) => {
          writer.write({
            type: COMMAND_EXECUTION_PART_TYPE,
            id: `${serverAssistantMessageId}-command-${index}`,
            data: commandExecutionDataFromPlan(plan),
          });
        });
        // Resolve once outside the per-attempt factory (the factory is synchronous).
        const modelCapabilitiesForTools = await getModelCapabilities(currentModel, currentProvider);
        // Server-side, in-request retry: transparently re-drive the loop under one
        // message envelope when an attempt drops mid-loop or ends without finishing.
        // The loop lives inside execute(), so onFinish still fires exactly once below.
        const runResult = await runAgentWithRetry({
          writer,
          abortSignal,
          baseMessages: modelMessages,
          finishToolName: FINISH_TOOL_NAME,
          pauseToolNames: [ASK_USER_TOOL_NAME],
          maxSteps: AGENT_MAX_STEPS,
          startTimeMs: startTime,
          logger: loggers.api,
          buildStreamText: (messages) => {
            // Volatile per-turn data (timestamp/location/mention/command) is
            // appended to the last user message so the stable system prefix
            // stays byte-identical across turns and provider prefix caches
            // survive — including turns where only the user's page changed.
            const turnContext = buildVolatileTurnContext({
              timestampPrompt: timestampSystemPrompt,
              locationPrompt,
              mentionPrompt: mentionSystemPrompt,
              commandCatalogPrompt: userCommandCatalog.catalogPrompt,
              commandPrompt: commandSystemPrompt,
            });
            const messagesWithContext = appendTurnContextToLastUserMessage(messages, turnContext);
            // Apply cache breakpoints: A) last message, B) summary/elision boundary.
            const cachedMessages = withCacheBreakpoints(messagesWithContext, stableBoundaryIndex);
            return streamText({
            model,
            // Stable system prompt — volatile sections removed; stays byte-identical
            // across turns so provider prefix caches are not invalidated.
            system: finalSystemPrompt,
            messages: cachedMessages,
            tools: finalTools,
            // hasToolCall(ASK_USER_TOOL_NAME) is documentation: ask_user has no
            // execute, so v6 halts the loop on it anyway (finishReason 'tool-calls').
            stopWhen: [hasToolCall(FINISH_TOOL_NAME), hasToolCall(ASK_USER_TOOL_NAME), stepCountIs(AGENT_MAX_STEPS)],
            // abortSignal from the abort registry — only fires on explicit user stop, never on client disconnect
            abortSignal,
            experimental_context: {
              userId,
              timezone: userTimezone,
              aiProvider: currentProvider,
              aiModel: currentModel,
              conversationId,
              locationContext,
              // Turn-start snapshot of the agent's working page — tools that
              // shift focus (e.g. create_page) mutate this in place so later
              // tool calls in the same turn track the agent's own actions
              // rather than staying pinned to the turn-start snapshot.
              currentWorkingPage: locationContext?.currentPage ? {
                id: locationContext.currentPage.id,
                title: locationContext.currentPage.title,
                type: locationContext.currentPage.type,
              } : undefined,
              modelCapabilities: modelCapabilitiesForTools,
              isAdmin: auth.role === 'admin',
              subscriptionTier: userSubscriptionTier,
              imageGenerationModel: userImageGenerationModel ?? DEFAULT_IMAGE_MODEL,
              chatSource: { type: 'global' as const },
              // Worker-dispatch chain depth (spawn_session/send_session) — the
              // X-Agent-Dispatch-Depth header is how depth survives the HTTP
              // hop; forging it low is the default, forging it high only
              // restricts the forger. 0 for a direct user request.
              agentCallDepth: agentDispatchDepth,
            },
            maxRetries: 20,
            onChunk: ({ chunk }) => {
              const part = chunkToPart(chunk as never);
              if (part) lifecycle!.pushPart(part);
            },
            onAbort: () => {
              loggers.api.info('Global Assistant Chat API: Stream aborted by user', {
                userId: maskIdentifier(userId),
                conversationId,
                streamId,
                model: currentModel,
                provider: currentProvider,
              });
              lifecycle!.finish(true);
            },
            // Re-mark breakpoints per step; stableBoundaryIndex is fixed for this request.
            prepareStep: ({ messages: stepMessages }) => ({
              messages: withCacheBreakpoints(stepMessages, stableBoundaryIndex),
            }),
            })
          },
        });

        // Billing reads the SUMMED usage / OpenRouter cost across every attempt.
        // Single onFinish → single consumeCredits → one hold settle: no double-charge,
        // but failed/partial attempts ARE billed (the provider charged us for them).
        agentRun = runResult;

        // Durable server-side persistence — runs regardless of whether the client is still
        // connected. onFinish is coupled to the response stream and may never fire when the
        // mobile client backgrounds mid-stream (exactly the scenario #2065 fixed client-side
        // for this same route — recovery only helps if the server actually settled the row).
        // Mirrors chat/route.ts's execute-end block: unconditional, using whatever lifecycle
        // has buffered so far. onFinish, when it runs, refines this write with the richer SDK
        // responseMessage; when onFinish never runs, this write stands as the sole record.
        // See Server Stream Durability epic PR 2 — CodeRabbit review.
        {
          const bufferedParts = lifecycle!.getBufferedParts();
          const aborted = isRunAborted({ agentRun, abortSignal });
          const payload = buildAssistantPersistencePayload(serverAssistantMessageId, bufferedParts);
          try {
            await saveTerminalGlobalAssistantMessage({
              messageId: serverAssistantMessageId,
              conversationId,
              userId,
              role: 'assistant',
              ...payload,
              status: aborted ? 'interrupted' : 'complete',
            });
            assistantMessagePersisted = true;
            // lastMessageAt bump: now inside the repository's save
            // transaction, alongside the rev counter — no separate write.
          } catch (e) {
            loggers.api.error('Global Assistant Chat API: execute-end persist failed', e as Error);
          }
        }
      },
      onFinish: async ({ responseMessage }) => {
        // Clean up abort controller from registry
        removeStream({ streamId });

        loggers.api.debug('Global Assistant Chat API: onFinish callback triggered for AI response', {});

        const messageId = serverAssistantMessageId;

        // Computed once and reused below (persist status + lifecycle.finish's aborted flag) so
        // the two can never disagree about whether this run was stopped.
        const aborted = isRunAborted({ agentRun, abortSignal });

        // Extract tool calls/results with safe defaults — responseMessage is absent on
        // exhausted/no-content runs, but usage settlement below still has to run.
        const extractedToolCalls = responseMessage ? extractToolCalls(responseMessage) : [];
        const extractedToolResults = responseMessage ? extractToolResults(responseMessage) : [];

        // Save the assistant message. Best-effort: persistence errors must NOT skip
        // usage/credit settlement below — that would leak the gate's hold. This is the
        // "refine with the richer SDK responseMessage" step — execute-end above already
        // terminalized the row unconditionally, so when responseMessage is absent there is
        // nothing richer to refine with and nothing left to do here.
        //
        // !lifecycle?.preAborted: the AI SDK always calls onFinish with a non-null
        // responseMessage (an empty {parts: []} shell when execute() wrote nothing), even for a
        // pre-aborted stream where the placeholder INSERT above was deliberately skipped. Without
        // this guard, the upsert would INSERT a brand-new phantom empty 'interrupted' row for a
        // request that never reached the model — see Server Stream Durability epic PR 2 review.
        if (responseMessage && !lifecycle?.preAborted) {
          try {
            const messageContent = extractMessageContent(responseMessage);

            loggers.api.debug('Global Assistant Chat API: Saving AI response message', {
              id: messageId,
              contentLength: messageContent.length,
              toolCallsCount: extractedToolCalls.length,
              toolResultsCount: extractedToolResults.length,
            });

            await saveTerminalGlobalAssistantMessage({
              messageId,
              conversationId,
              userId,
              role: 'assistant',
              content: messageContent,
              toolCalls: extractedToolCalls.length > 0 ? extractedToolCalls : undefined,
              toolResults: extractedToolResults.length > 0 ? extractedToolResults : undefined,
              uiMessage: responseMessage,
              status: aborted ? 'interrupted' : 'complete',
            });
            assistantMessagePersisted = true;

            // lastMessageAt bump: now inside the repository's save
            // transaction, alongside the rev counter — no separate write.
            loggers.api.debug('Global Assistant Chat API: AI response message saved to database', {});
          } catch (error) {
            loggers.api.error('Global Assistant Chat API: Failed to save AI response message', error as Error);
          }
        } else {
          loggers.api.debug('Global Assistant Chat API: no responseMessage — execute-end already terminalized this row', {});
        }

        // Usage + credit settlement ALWAYS runs after runAgentWithRetry completes —
        // regardless of whether a responseMessage was produced or persistence above
        // succeeded. trackUsage settles the gate's hold (holdId); skipping it on
        // exhausted/no-content runs or save failures would leak the hold (the route
        // already set holdHandedOff = true).
        //
        // Track detailed AI usage (tokens, cost, etc.).
        // ALWAYS log a row — even when the provider returns no usage metadata —
        // so the orphan-sweep can recover/bill it. Missing tokens mean a $0 cost
        // row, not a skipped one (which would silently front the spend).
        try {
          const usage = agentRun?.accumulatedUsage;
          const steps = agentRun?.accumulatedSteps;
          const duration = Date.now() - startTime;

          await AIMonitoring.trackUsage({
            userId: userId!,
            provider: currentProvider,
            model: currentModel,
            source: 'chat',
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
            totalTokens: usage?.totalTokens,
            cachedInputTokens: usage?.cachedInputTokens,
            reasoningTokens: usage?.reasoningTokens,
            providerCostDollars: extractOpenRouterCostDollars(steps),
            openrouterGenerationIds: extractOpenRouterGenerationIds(steps),
            duration,
            conversationId,
            messageId,
            // 'exhausted' = retry shell gave up (failure); clean/terminal = a real
            // completion. Cost still settles regardless (the provider charged us).
            success: agentRun?.finalOutcome !== 'exhausted',
            holdId,
            contextMessages: contextCalculation.messageIds,
            contextSize: contextCalculation.totalTokens,
            systemPromptTokens: contextCalculation.systemPromptTokens,
            toolDefinitionTokens: contextCalculation.toolDefinitionTokens,
            conversationTokens: contextCalculation.conversationTokens,
            messageCount: contextCalculation.messageCount,
            wasTruncated: contextCalculation.wasTruncated,
            truncationStrategy: contextCalculation.truncationStrategy,
            metadata: {
              toolCallsCount: extractedToolCalls.length,
              toolResultsCount: extractedToolResults.length,
              isReadOnly: readOnlyMode,
              retryAttempts: agentRun?.attempts,
              retryOutcome: agentRun?.finalOutcome,
              retryTerminalReason: agentRun?.terminalReason,
            }
          });
        } catch (trackingError) {
          loggers.api.debug('Global Assistant: Could not track AI usage (stream aborted or failed)', {
            conversationId: maskIdentifier(conversationId),
            messageId: maskIdentifier(messageId),
            error: trackingError instanceof Error ? trackingError.message : 'Unknown error',
          });
        }

        // NOTE: daily per-call counting/broadcast removed — prepaid credits are
        // the sole volume limiter. The credit hold placed by the gate is settled
        // by the AIMonitoring.trackUsage call above (holdId threaded in), which
        // now also broadcasts the user's fresh balance — so no route-level emit
        // is needed for the header widget to update live.

        // Schedule compaction for the NEXT request (summarises old tail via after()).
        scheduleCompaction();

        // Reflect a user stop, including one that landed during inter-attempt backoff or
        // raced in after the loop broke (onAbort only fires while a streamText is live).
        // finish() is idempotent, so this is a no-op if onAbort already ran.
        lifecycle!.finish(aborted);
      },
    });

    loggers.api.debug('Global Assistant Chat API: Returning stream response', {});

    // The stream's onFinish now owns hold release (via AIMonitoring.trackUsage).
    holdHandedOff = true;
    return createUIMessageStreamResponse({
      stream,
      headers: { [STREAM_ID_HEADER]: streamId },
    });

  } catch (error) {
    if (activeStreamId !== undefined) {
      removeStream({ streamId: activeStreamId });
    }
    // Captured BEFORE finish() — finish() deletes the multicast registry entry backing
    // getBufferedParts(), so calling it after finish() would always see an empty buffer and
    // silently discard any real partial content the cleanup write below is meant to preserve.
    const bufferedPartsAtError = lifecycle?.getBufferedParts() ?? [];
    lifecycle?.finish(true);

    // Last-resort cleanup: something threw before onFinish ever got a chance to settle the
    // placeholder row (e.g. createUIMessageStream itself failed to construct). Without this,
    // the row is stuck at 'streaming' forever — excluded from every reader by default AND
    // rejected by edit/delete's 409 guard. Guarded by assistantMessagePersisted so this can
    // never downgrade an already-'complete'/'interrupted' row written earlier in the SAME
    // request. Best-effort: must not itself throw or block the error response.
    //
    // Requires `lifecycle` itself (not just `!lifecycle?.preAborted`) so this never fires for a
    // throw that happened INSIDE startGenerationExclusive's callback, before `lifecycle` is ever
    // assigned — e.g. takeOverConversationStreams or createStreamLifecycle failing (the
    // placeholder INSERT itself has its own try/catch and can no longer throw here). In that
    // window no placeholder row exists at all, so this upsert would INSERT a stray phantom
    // 'interrupted' row for a request that never started generating.
    if (!assistantMessagePersisted && cleanupContext && lifecycle && !lifecycle.preAborted) {
      try {
        const payload = buildAssistantPersistencePayload(cleanupContext.serverAssistantMessageId, bufferedPartsAtError);
        await saveTerminalGlobalAssistantMessage({
          messageId: cleanupContext.serverAssistantMessageId,
          conversationId: cleanupContext.conversationId,
          userId: cleanupContext.userId,
          role: 'assistant',
          ...payload,
          status: 'interrupted',
        });
      } catch (cleanupError) {
        loggers.api.error('Global Assistant Chat API: failed to terminalize placeholder row after error', cleanupError as Error);
      }
    }

    loggers.api.error('Global Assistant Chat API Error:', error as Error);

    return NextResponse.json({
      error: 'Failed to process chat request. Please try again.'
    }, { status: 500 });
  } finally {
    // Pre-generation early return or throw: the stream never took ownership, so
    // free the reservation now rather than waiting for the reconcile sweep.
    if (holdId && !holdHandedOff) void releaseHold(holdId).catch(() => {});
  }
}
