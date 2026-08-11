/**
 * Loading the bound conversation's history and turning it into a seed.
 *
 * The IO half of `seed.ts`: read the thread, check the caller may see it, hand
 * the rows to the pure builder. It runs at HANDSHAKE time, in the web tier,
 * because that is where the repositories and the permission predicate live —
 * and the result rides the attach payload so the seed is already in the
 * realtime server's hand when the socket reaches `session.updated`, rather than
 * costing a round trip while the caller waits to be heard.
 *
 * A seed is never a reason to fail a call. Every unhappy path below returns an
 * empty seed: an unbound call, a conversation that does not exist yet (the
 * common case — a fresh thread's row is created by its first message), one the
 * caller may not read, or a read that failed. The call still connects, still
 * runs tools, still meters; it simply starts without history, which is exactly
 * what a new conversation does anyway.
 */

import { buildRealtimeSeed, type SeedEvent, type SeedMessage } from './seed';

/** The conversation facts the access check needs. A `conversations` row satisfies it. */
export type SeedConversation = {
  readonly userId: string;
  readonly isShared: boolean;
  readonly type: string;
  readonly contextId: string | null;
  readonly isActive: boolean;
};

export type SeedLoaderDeps = {
  readonly loadConversation: (conversationId: string) => Promise<SeedConversation | undefined>;
  readonly canAccess: (userId: string, conversation: SeedConversation) => Promise<boolean>;
  readonly loadMessages: (conversationId: string) => Promise<readonly SeedMessage[]>;
  readonly logger: {
    readonly warn: (message: string, meta?: Record<string, unknown>) => void;
  };
};

export type SeedLoaderRequest = {
  readonly userId: string;
  readonly conversationId?: string;
  readonly maxTurns?: number;
  readonly maxTokens?: number;
};

export const loadRealtimeSeed = async (
  deps: SeedLoaderDeps,
  request: SeedLoaderRequest,
): Promise<SeedEvent[]> => {
  if (!request.conversationId) return [];

  try {
    const conversation = await deps.loadConversation(request.conversationId);
    // No row is the ORDINARY case, not an error: a thread the user just opened
    // has a client-minted id and no row until its first message lands.
    if (!conversation || !conversation.isActive) return [];

    if (!(await deps.canAccess(request.userId, conversation))) {
      deps.logger.warn('Realtime voice seed refused: caller cannot access the conversation', {
        userId: request.userId,
        conversationId: request.conversationId,
      });
      return [];
    }

    const messages = await deps.loadMessages(request.conversationId);
    return buildRealtimeSeed(messages, {
      ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    });
  } catch (error) {
    // Degrading to no history is strictly better than degrading to no call.
    deps.logger.warn('Realtime voice seed could not be loaded; starting without history', {
      userId: request.userId,
      conversationId: request.conversationId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
};
