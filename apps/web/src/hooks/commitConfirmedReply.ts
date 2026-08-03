import type { UIMessage } from 'ai';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';

/**
 * The ONE finished-reply commit protocol, shared by the socket
 * `onStreamComplete` commit branch (conversationCacheSocketHandlers) and the
 * sender's local `onFinish` commit (buildOwnStreamCommitOnFinish) — so the
 * ordering contract lives in code, not in "mirrors exactly" comments:
 *
 * - F1: promote optimistic sends FIRST, and only for THIS TAB'S OWN reply —
 *   an own reply proves the user rows that triggered it are persisted (the
 *   route persists the user message before generating), and promoting before
 *   the commit means the question can never render below the answer. A remote
 *   reply proves nothing about this tab's sends.
 * - COMMIT by id — upsert, never skip: an existing row under this id may be a
 *   half-streamed includeStreaming placeholder that must be overwritten.
 * - F6: background snapshot heal — the socket broadcast can outrace the SSE
 *   multicast's final frames, so committed parts may be truncated; the heal
 *   reconciles the authoritative DB row (best-effort, generation-safe, no
 *   loading-state flip).
 */
export const commitConfirmedReply = (
  conversationId: string,
  message: UIMessage,
  opts: {
    /** True only when the reply is this tab's own send (F1 above). */
    promoteOwnSends: boolean;
    refreshSnapshot: (conversationId: string) => void | Promise<void>;
  },
): void => {
  if (opts.promoteOwnSends) {
    conversationMessagesActions.promoteOptimisticSends(conversationId);
  }
  conversationMessagesActions.applyConfirmedMessage(conversationId, message);
  void opts.refreshSnapshot(conversationId);
};
