/**
 * The real wiring behind the voice plane's web-side work.
 *
 * `seed-loader.ts`, `transcript-persistence.ts` and `tool-dispatch.ts` all take
 * their dependencies as arguments so their decision trees are exercisable
 * without a database. This is the one module that binds those arguments to the
 * live repositories, the live permission predicate and the live tool registry —
 * so there is exactly one place where "the real thing" is chosen, shared by the
 * two routes that need it (the handshake, which seeds; and the bridge, which
 * dispatches and persists).
 */

import { createId } from '@paralleldrive/cuid2';
import { canAccessConversation } from '@pagespace/lib/permissions/conversation-access';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { messageRepository } from '@/lib/repositories/message-repository';
import {
  resolveOrCreateConversation,
  ConversationHistoryDeletedError,
  ConversationOwnershipError,
} from '@/lib/repositories/resolve-or-create-conversation';
import { buildPageSpaceTools } from '@/lib/ai/core/ai-tools';
import { buildRealtimeToolSet } from './tools';
import type { SeedLoaderDeps, SeedConversation } from './seed-loader';
import type {
  TranscriptPersistenceDeps,
  TranscriptConversation,
} from './transcript-persistence';
import type { RealtimeToolDispatchDeps } from './tool-dispatch';

/**
 * The subset of a `conversations` row both consumers need. Narrowed here rather
 * than passing the whole row so neither module can quietly start depending on a
 * column it was not given.
 */
const narrow = (
  row: Awaited<ReturnType<typeof conversationRepository.getConversation>>,
): (SeedConversation & TranscriptConversation) | undefined =>
  row
    ? {
        id: row.id,
        userId: row.userId,
        isShared: row.isShared,
        type: row.type,
        contextId: row.contextId,
        isActive: row.isActive,
      }
    : undefined;

const loadConversation = async (conversationId: string) =>
  narrow(await conversationRepository.getConversation(conversationId));

export const voiceSeedDeps: SeedLoaderDeps = {
  loadConversation,
  canAccess: (userId, conversation) => canAccessConversation(userId, conversation),
  // Streaming placeholders stay excluded (the default): an empty mid-flight row
  // is not a turn, and `buildRealtimeSeed` would drop it anyway.
  loadMessages: (conversationId) =>
    messageRepository.getMessagesByConversationId(conversationId),
  logger: loggers.ai,
};

export const voiceTranscriptDeps: TranscriptPersistenceDeps = {
  loadConversation,
  createConversation: async (userId, conversationId) => {
    try {
      const { conversation } = await resolveOrCreateConversation(userId, conversationId);
      return narrow(conversation);
    } catch (error) {
      // Both are refusals with a name on them, not crashes: an id belonging to
      // someone else, and an id whose thread was deleted from history. Either
      // way the turn has nowhere to go, and the caller reports that.
      if (
        error instanceof ConversationOwnershipError ||
        error instanceof ConversationHistoryDeletedError
      ) {
        return undefined;
      }
      throw error;
    }
  },
  canAccess: (userId, conversation) => canAccessConversation(userId, conversation),
  saveGlobalMessage: (args) => messageRepository.saveGlobalMessage(args),
  savePageMessage: (args) => messageRepository.savePageMessage(args),
  newMessageId: () => createId(),
  logger: loggers.ai,
};

/**
 * The executable tool set, built the SAME way the session's advertised
 * definitions were (`buildRealtimeToolSet`), from the same registry factory.
 *
 * Built per request rather than at module load, for the reason `tools.ts`
 * gives: `buildPageSpaceTools` has env-dependent branches (the code-execution
 * kill switch), so freezing its result into a module-level constant would pin
 * whatever the environment looked like at import time.
 */
export const voiceToolDispatchDeps = (): RealtimeToolDispatchDeps => ({
  tools: buildRealtimeToolSet(buildPageSpaceTools()),
  logger: loggers.ai,
});
