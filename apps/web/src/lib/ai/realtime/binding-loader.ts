/**
 * Everything the handshake needs from the conversation a call is bound to,
 * behind ONE read and ONE access check.
 *
 * A voice call is a second transport onto a conversation that already exists,
 * so almost everything about the call is a fact about that conversation: the
 * history to seed, who is being talked to, what that assistant was told to be,
 * and which tools its owner allowed it. This runs at HANDSHAKE time, in the web
 * tier, because that is where the repositories and the permission predicate
 * live — and the result rides the attach payload so it is already in the
 * realtime server's hand when the socket reaches `session.updated`, rather than
 * costing a round trip while the caller waits to be heard.
 *
 * WHY ONE FUNCTION RATHER THAN TWO. The seed and the assistant are answers to
 * the same question — "what is this call bound to?" — and both are gated on the
 * same predicate. Split apart they would load the row twice and, worse, decide
 * access twice; the first time those two decisions disagreed, one of them would
 * be handing out something the other refused.
 *
 * A BINDING IS NEVER A REASON TO FAIL A CALL. Every unhappy path below returns
 * an empty binding: an unbound call, a conversation that does not exist yet (the
 * common case — a fresh thread's row is created by its first message), one the
 * caller may not read, or a read that failed. The call still connects, still
 * runs tools, still meters. It simply talks to the default assistant with no
 * history, which is exactly what a brand-new conversation does anyway.
 */

import { buildRealtimeSeed, type SeedEvent, type SeedMessage } from './seed';
import { buildVoiceInstructions } from './instructions';
import type { VoiceAssistant } from '@pagespace/lib/realtime/voice-bridge-contract';

/** The conversation facts the access check needs. A `conversations` row satisfies it. */
export type SeedConversation = {
  readonly userId: string;
  readonly isShared: boolean;
  readonly type: string;
  readonly contextId: string | null;
  readonly isActive: boolean;
};

/**
 * The agent page behind a `type: 'page'` conversation, as this module reads it.
 *
 * `type` is carried and checked rather than assumed: a conversation on any
 * non-AI_CHAT page also puts THAT page in `contextId`, and a document is not an
 * agent. Treating one as an agent would hand `resolveActingAgentId` a page for
 * which no `driveAgentMembers` row can ever exist, so every access lookup would
 * return null and deny — a call that silently cannot do anything.
 */
export type AgentPage = {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly systemPrompt: string | null;
  readonly enabledTools: string[] | null;
};

export type BindingLoaderDeps = {
  readonly loadConversation: (conversationId: string) => Promise<SeedConversation | undefined>;
  readonly canAccess: (userId: string, conversation: SeedConversation) => Promise<boolean>;
  readonly loadMessages: (conversationId: string) => Promise<readonly SeedMessage[]>;
  readonly loadAgentPage: (pageId: string) => Promise<AgentPage | undefined>;
  readonly logger: {
    readonly warn: (message: string, meta?: Record<string, unknown>) => void;
  };
};

export type BindingLoaderRequest = {
  readonly userId: string;
  readonly conversationId?: string;
  readonly maxTurns?: number;
  readonly maxTokens?: number;
};

/**
 * What a call is bound to.
 *
 * `instructions` is present even when `assistant` is not: the Global Assistant
 * has no agent page, but it still has a persona, and a spoken conversation
 * still needs to be told it is spoken. `assistant` is set only for a real page
 * agent, because it is what tool execution authorizes AS.
 */
export type VoiceBinding = {
  readonly seed: SeedEvent[];
  readonly instructions: string;
  readonly assistant?: VoiceAssistant;
};

/** The binding for a call with nothing to bind to: no history, default persona. */
const unbound = (): VoiceBinding => ({
  seed: [],
  instructions: buildVoiceInstructions({}),
});

/**
 * Resolve the page agent behind a conversation, if there is one.
 *
 * Returns undefined for a global or drive conversation, for a page
 * conversation whose page is not an agent, and for a page that no longer
 * exists. The CONVERSATION's access check has already run by this point — the
 * caller may read this thread, and the agent is the thread's own, not one
 * named by the browser.
 *
 * A FAILED LOOKUP COSTS THE IDENTITY, NOT THE HISTORY. Caught here rather than
 * left to the outer handler so a transient read does not also throw away a
 * seed that was fetched successfully alongside it. The call then runs as the
 * Global Assistant, acting as the authenticated user — which is what EVERY
 * voice call did before the binding existed, and is bounded by that user's own
 * ACL, never beyond it. Logged, because a page conversation whose agent cannot
 * be read is not an ordinary outcome the way a missing page row is.
 */
const resolveAgent = async (
  deps: BindingLoaderDeps,
  conversation: SeedConversation,
): Promise<AgentPage | undefined> => {
  if (conversation.type !== 'page' || !conversation.contextId) return undefined;
  try {
    const page = await deps.loadAgentPage(conversation.contextId);
    return page?.type === 'AI_CHAT' ? page : undefined;
  } catch (error) {
    deps.logger.warn('Realtime voice binding could not read its agent page; acting as the user', {
      conversationId: conversation.contextId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  }
};

export const loadVoiceBinding = async (
  deps: BindingLoaderDeps,
  request: BindingLoaderRequest,
): Promise<VoiceBinding> => {
  if (!request.conversationId) return unbound();

  try {
    const conversation = await deps.loadConversation(request.conversationId);
    // No row is the ORDINARY case, not an error: a thread the user just opened
    // has a client-minted id and no row until its first message lands.
    if (!conversation || !conversation.isActive) return unbound();

    if (!(await deps.canAccess(request.userId, conversation))) {
      deps.logger.warn('Realtime voice binding refused: caller cannot access the conversation', {
        userId: request.userId,
        conversationId: request.conversationId,
      });
      return unbound();
    }

    const [messages, agent] = await Promise.all([
      deps.loadMessages(request.conversationId),
      resolveAgent(deps, conversation),
    ]);

    const seed = buildRealtimeSeed(messages, {
      ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    });

    if (!agent) return { seed, instructions: buildVoiceInstructions({}) };

    return {
      seed,
      instructions: buildVoiceInstructions({
        title: agent.title,
        ...(agent.systemPrompt === null ? {} : { systemPrompt: agent.systemPrompt }),
      }),
      assistant: {
        agentPageId: agent.id,
        agentTitle: agent.title,
        enabledTools: agent.enabledTools,
      },
    };
  } catch (error) {
    // Degrading to no history and the default persona is strictly better than
    // degrading to no call.
    deps.logger.warn('Realtime voice binding could not be loaded; starting unbound', {
      userId: request.userId,
      conversationId: request.conversationId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return unbound();
  }
};
