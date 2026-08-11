/**
 * The real wiring behind the voice plane's web-side work.
 *
 * `binding-loader.ts`, `transcript-persistence.ts` and `tool-dispatch.ts` all take
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
import {
  messageRepository,
  type BeforeSaveHook,
} from '@/lib/repositories/message-repository';
import {
  resolveOrCreateConversation,
  ConversationHistoryDeletedError,
  ConversationOwnershipError,
} from '@/lib/repositories/resolve-or-create-conversation';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { buildPageSpaceTools } from '@/lib/ai/core/ai-tools';
import { buildRealtimeToolSet, type ToolAllowlist } from './tools';
import type { BindingLoaderDeps, SeedConversation, AgentPage } from './binding-loader';
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

/**
 * The agent page behind a page conversation.
 *
 * Selected column by column rather than by row: the caller needs the agent's
 * persona and its allowlist, and a `pages` row also carries content, encrypted
 * fields and everything else a page can hold.
 */
const loadAgentPage = async (pageId: string): Promise<AgentPage | undefined> => {
  const [row] = await db
    .select({
      id: pages.id,
      type: pages.type,
      title: pages.title,
      systemPrompt: pages.systemPrompt,
      enabledTools: pages.enabledTools,
    })
    .from(pages)
    .where(eq(pages.id, pageId));
  return row
    ? {
        id: row.id,
        type: row.type,
        title: row.title,
        systemPrompt: row.systemPrompt,
        enabledTools: Array.isArray(row.enabledTools) ? (row.enabledTools as string[]) : null,
      }
    : undefined;
};

/**
 * Re-decide "is this conversation still there?" INSIDE the write transaction,
 * holding the row.
 *
 * `persistVoiceTranscript` checks `isActive` before it writes, but a call is a
 * conversation held open for minutes: the window between that check and the
 * insert is not a few microseconds, it is however long the bridge hop takes,
 * and a user deleting the thread mid-call lands squarely in it. Without a hook
 * the repository's `beforeSave` defaults to allowing the write, so a spoken
 * turn would be persisted under a conversation no listing can reach.
 *
 * `FOR UPDATE` is what makes it a decision rather than a second guess — it
 * serialises against the delete, so the two cannot both believe they won. The
 * typed chat paths carry the same re-check for the same reason; theirs differ
 * in what they do about a MISSING row, because they can race their own eager
 * conversation creation. Voice cannot: every path reaching these two wrappers
 * has already loaded or created the row, so a row that is gone by now was
 * deleted, and refusing is the honest answer.
 */
const activeConversationGuard =
  (conversationId: string): BeforeSaveHook =>
  async (tx) => {
    const [row] = await tx
      .select({ isActive: conversations.isActive })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('update')
      .limit(1);
    return row?.isActive === true;
  };

export const voiceBindingDeps: BindingLoaderDeps = {
  loadConversation,
  canAccess: (userId, conversation) => canAccessConversation(userId, conversation),
  // Streaming placeholders stay excluded (the default): an empty mid-flight row
  // is not a turn, and `buildRealtimeSeed` would drop it anyway.
  loadMessages: (conversationId) =>
    messageRepository.getMessagesByConversationId(conversationId),
  loadAgentPage,
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
  saveGlobalMessage: (args) =>
    messageRepository.saveGlobalMessage({
      ...args,
      beforeSave: activeConversationGuard(args.conversationId),
    }),
  savePageMessage: (args) =>
    messageRepository.savePageMessage({
      ...args,
      beforeSave: activeConversationGuard(args.conversationId),
    }),
  newMessageId: () => createId(),
  logger: loggers.ai,
};

/**
 * The executable tool set, built the SAME way the session's advertised
 * definitions were (`buildRealtimeToolSet`), from the same registry factory and
 * — critically — under the same agent allowlist.
 *
 * The allowlist is a PARAMETER because the advertised set and the executable
 * set are built in different processes on different requests: the definitions
 * are built once at handshake and ride the attach payload, while this runs per
 * tool call on the bridge. Building this one unrestricted would mean the model
 * is offered the agent's allowed tools and permitted to run any of them, which
 * is the wider of the two lists winning.
 *
 * Built per request rather than at module load, for the reason `tools.ts`
 * gives: `buildPageSpaceTools` has env-dependent branches (the code-execution
 * kill switch), so freezing its result into a module-level constant would pin
 * whatever the environment looked like at import time.
 */
export const voiceToolDispatchDeps = (
  allowlist: ToolAllowlist = null,
): RealtimeToolDispatchDeps => ({
  tools: buildRealtimeToolSet(buildPageSpaceTools(), allowlist),
  logger: loggers.ai,
});
