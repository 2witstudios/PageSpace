import type { UIMessage } from 'ai';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';

/**
 * Facade — the sanctioned way for a component to WRITE to
 * `useConversationMessagesStore` (see PR 4 board: container-agnostic consumer
 * rule). Components call these instead of `useConversationMessagesStore.getState()`
 * directly, so a state-container swap (zustand → @adobe/data ECS, per the
 * platform spike) stays a facade-internal change instead of a consumer rewrite.
 *
 * Plain functions, not a hook: every call site here is imperative (a user
 * action or a socket-event callback), never a render-time read.
 */
export const conversationMessagesActions = {
  /** Starts a new load generation for `conversationId`; pair with `isLoadCurrent`/`applyLoad`/`failLoad`. */
  startLoad: (conversationId: string): number => useConversationMessagesStore.getState().startLoad(conversationId),
  /** True while `generation` is still the newest `startLoad` result for `conversationId` — false once a newer load has superseded it. */
  isLoadCurrent: (conversationId: string, generation: number): boolean =>
    useConversationMessagesStore.getState().byConversationId[conversationId]?.loadGeneration === generation,
  applyLoad: (conversationId: string, generation: number, messages: UIMessage[]): void =>
    useConversationMessagesStore.getState().applyLoad(conversationId, generation, messages),
  failLoad: (conversationId: string, generation: number): void =>
    useConversationMessagesStore.getState().failLoad(conversationId, generation),
  addOptimisticSend: (conversationId: string, message: UIMessage): void =>
    useConversationMessagesStore.getState().addOptimisticSend(conversationId, message),
  applyEdit: (conversationId: string, payload: MessageEditPayload): void =>
    useConversationMessagesStore.getState().applyEdit(conversationId, payload),
  applyDelete: (conversationId: string, messageId: string): void =>
    useConversationMessagesStore.getState().applyDelete(conversationId, messageId),
  /**
   * Commits a confirmed message (role-agnostic despite the store action's name —
   * see the PR 4 board note on `onStreamComplete`'s reuse of this for a completed
   * own-stream's final assistant message) into `messages`, reconciling it out of
   * `optimisticSends` if present.
   */
  applyRemoteUserMessage: (conversationId: string, message: UIMessage): void =>
    useConversationMessagesStore.getState().applyRemoteUserMessage(conversationId, message),
};
