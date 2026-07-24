import type { UIMessage } from 'ai';
import type { ConversationCacheEntry, ConversationMessagesById } from '@/stores/conversationMessages/seedEmpty';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import type { AskUserAnswerPayload, AskUserAnswerRevertPayload } from '@/lib/ai/streams/applyAskUserAnswer';
import { readAllConversations } from '../conversationEntry';
import type { ChatStateDatabase } from '../chat-state-plugin';

/**
 * SPIKE (@adobe/data adoption evidence). The zustand-shaped facade over the
 * ported Database.
 *
 * This is the interop proof: `useConversationMessagesStore`'s public surface
 * (`getState()` returning `byConversationId` plus the same action names and
 * signatures, `setState` for teardown) re-expressed over the ECS container, so
 * every existing consumer of the store keeps compiling and behaving while the
 * container underneath is @adobe/data instead of zustand — and untouched
 * zustand stores elsewhere in the app are unaffected, because nothing about
 * this container is global.
 *
 * It is deliberately NOT a React hook: the rendering path under adoption is
 * `useObservableValues` over `db.computed.conversationEntry(id)` (see the
 * harness route). This facade exists for the imperative `getState()` call
 * sites the epic's effects use.
 */
export interface ConversationMessagesFacadeState {
  byConversationId: ConversationMessagesById;
  getEntry: (conversationId: string) => ConversationCacheEntry;
  startLoad: (conversationId: string) => number;
  isLoadCurrent: (conversationId: string, generation: number) => boolean;
  applyLoad: (
    conversationId: string,
    generation: number,
    messages: UIMessage[],
    pagination?: { hasMore: boolean; nextCursor: string | null },
  ) => void;
  failLoad: (conversationId: string, generation: number) => void;
  startLoadingOlder: (conversationId: string) => void;
  applyOlderPage: (
    conversationId: string,
    generation: number,
    messages: UIMessage[],
    hasMoreOlder: boolean,
    nextCursor: string | null,
  ) => void;
  failLoadingOlder: (conversationId: string, generation: number) => void;
  addOptimisticSend: (conversationId: string, message: UIMessage) => void;
  removeOptimisticSendOnFailure: (conversationId: string, messageId: string) => void;
  applyEdit: (conversationId: string, payload: MessageEditPayload) => void;
  applyDelete: (conversationId: string, messageId: string) => void;
  applyAskUserAnswer: (conversationId: string, payload: AskUserAnswerPayload) => void;
  revertAskUserAnswer: (conversationId: string, payload: AskUserAnswerRevertPayload) => void;
  applyRemoteUserMessage: (conversationId: string, message: UIMessage) => void;
  applyConfirmedMessage: (conversationId: string, message: UIMessage) => void;
  promoteOptimisticSends: (conversationId: string) => void;
  beginServerSnapshot: (conversationId: string) => number;
  applyServerSnapshot: (conversationId: string, generationToken: number, messages: UIMessage[]) => void;
  seedConversation: (conversationId: string) => void;
}

export interface ConversationMessagesFacade {
  getState: () => ConversationMessagesFacadeState;
  /** Only the `{ byConversationId: {} }` teardown form is meaningful on an ECS container. */
  setState: (partial: { byConversationId: ConversationMessagesById }) => void;
}

export const createConversationMessagesFacade = (db: ChatStateDatabase): ConversationMessagesFacade => {
  const getState = (): ConversationMessagesFacadeState => ({
    byConversationId: readAllConversations(db),
    getEntry: (conversationId) => db.actions.getEntry(conversationId),
    startLoad: (conversationId) => db.actions.startLoad(conversationId),
    isLoadCurrent: (conversationId, generation) => db.actions.isLoadCurrent({ conversationId, generation }),
    applyLoad: (conversationId, generation, messages, pagination) => {
      db.transactions.applyLoad({ conversationId, generation, messages, pagination });
    },
    failLoad: (conversationId, generation) => {
      db.transactions.failLoad({ conversationId, generation });
    },
    startLoadingOlder: (conversationId) => {
      db.transactions.startLoadingOlder(conversationId);
    },
    applyOlderPage: (conversationId, generation, messages, hasMoreOlder, nextCursor) => {
      db.transactions.applyOlderPage({ conversationId, generation, messages, hasMoreOlder, nextCursor });
    },
    failLoadingOlder: (conversationId, generation) => {
      db.transactions.failLoadingOlder({ conversationId, generation });
    },
    addOptimisticSend: (conversationId, message) => {
      db.transactions.addOptimisticSend({ conversationId, message });
    },
    removeOptimisticSendOnFailure: (conversationId, messageId) => {
      db.transactions.removeOptimisticSendOnFailure({ conversationId, messageId });
    },
    applyEdit: (conversationId, payload) => {
      db.transactions.applyEdit({ conversationId, payload });
    },
    applyDelete: (conversationId, messageId) => {
      db.transactions.applyDelete({ conversationId, messageId });
    },
    applyAskUserAnswer: (conversationId, payload) => {
      db.transactions.applyAskUserAnswer({ conversationId, payload });
    },
    revertAskUserAnswer: (conversationId, payload) => {
      db.transactions.revertAskUserAnswer({ conversationId, payload });
    },
    applyRemoteUserMessage: (conversationId, message) => {
      db.transactions.applyRemoteUserMessage({ conversationId, message });
    },
    applyConfirmedMessage: (conversationId, message) => {
      db.transactions.applyConfirmedMessage({ conversationId, message });
    },
    promoteOptimisticSends: (conversationId) => {
      db.transactions.promoteOptimisticSends(conversationId);
    },
    beginServerSnapshot: (conversationId) => db.actions.beginServerSnapshot(conversationId),
    applyServerSnapshot: (conversationId, generationToken, messages) => {
      db.transactions.applyServerSnapshot({ conversationId, generationToken, messages });
    },
    seedConversation: (conversationId) => {
      db.transactions.seedConversation(conversationId);
    },
  });

  return {
    getState,
    setState: (partial) => {
      if (Object.keys(partial.byConversationId).length > 0) {
        throw new Error(
          'conversationMessagesFacade.setState only supports the empty-reset form; seed state through transactions.',
        );
      }
      db.transactions.resetChatState();
    },
  };
};
