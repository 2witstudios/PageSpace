/**
 * useCacheMessageActions — the ONE store-first wrapper around useMessageActions
 * (F2 + F9, PR #2098 review), shared by AiChatView, GlobalAssistantView and
 * SidebarChatTab so the edit/delete/retry cache semantics cannot drift between
 * surfaces.
 *
 * ACTIONS OPERATE ON SETTLED ROWS ONLY. The rendered list includes synthesized
 * live-stream rows (mode 'streaming'), and feeding those into the action hook
 * let Retry select an IN-FLIGHT assistant message: handleRetry then DELETEd the
 * streaming message's DB row mid-generation (destroying a collaborator's — or a
 * second tab's — reply server-side) and kicked off a duplicate, double-billed
 * regenerate. Stop is the verb for a live stream; edit/delete/retry act on
 * settled content, so `stableMessages` filters mode 'streaming' out before
 * anything action-shaped sees the list. Surfaces keep passing the RENDERED
 * last-assistant id to their layouts (affordance placement + streaming
 * animation are display concerns over the rendered list).
 *
 * CACHE WRITES AFTER THE BASE CALL RESOLVES (network-confirmed): the sender's
 * own tab never receives its own edited/deleted broadcast back, so without the
 * explicit cache write the action would render no change. A base-call failure
 * rolls back inside useMessageActions and leaves the cache untouched.
 */
import { useCallback, useMemo } from 'react';
import type { UIMessage } from 'ai';
import { useMessageActions } from './useMessageActions';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { getAssistantMessagesAfterLastUser } from '@/lib/ai/streams/getAssistantMessagesAfterLastUser';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import type { RenderedMessage } from '@/lib/ai/streams/selectRenderedMessages';

export interface UseCacheMessageActionsOptions {
  /** For agent mode: the agent/page ID. For global mode: null. */
  agentId: string | null;
  conversationId: string | null;
  /** The full rendered list (selectRenderedMessages output, mode included). */
  renderedMessages: RenderedMessage[];
  /**
   * Is THIS surface's own send live right now (status submitted/streaming OR an
   * own store entry)? Gates every transport-array write here — the own-stream
   * mirror reads that array to find its live stream.
   */
  isOwnSendLive: boolean;
  /** This surface's useChat setter (transport bookkeeping only — never renders). */
  setMessages: (messages: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void;
  regenerate: (options?: { body?: Record<string, unknown> }) => void;
}

export interface UseCacheMessageActionsResult {
  handleEdit: (messageId: string, newContent: string) => Promise<void>;
  handleDelete: (messageId: string) => Promise<void>;
  handleRetry: () => Promise<void>;
  /** Rendered rows minus live-stream synth rows — what every action reasons over. */
  stableMessages: UIMessage[];
}

export function useCacheMessageActions({
  agentId,
  conversationId,
  renderedMessages,
  isOwnSendLive,
  setMessages,
  regenerate,
}: UseCacheMessageActionsOptions): UseCacheMessageActionsResult {
  const stableMessages = useMemo(
    () => renderedMessages.filter((r) => r.mode !== 'streaming').map((r) => r.message),
    [renderedMessages],
  );

  const {
    handleEdit: handleEditBase,
    handleDelete: handleDeleteBase,
    handleRetry: handleRetryBase,
  } = useMessageActions({
    agentId,
    conversationId,
    messages: stableMessages,
    setMessages,
    regenerate,
    isOwnStreamLive: isOwnSendLive,
  });

  const handleEdit = useCallback(async (messageId: string, newContent: string) => {
    const original = stableMessages.find((m) => m.id === messageId);
    await handleEditBase(messageId, newContent);
    if (!conversationId || !original) return;
    const payload: MessageEditPayload = {
      messageId,
      parts: original.parts.map((p) => (p.type === 'text' ? { ...p, text: newContent } : p)),
      editedAt: new Date(),
    };
    conversationMessagesActions.applyEdit(conversationId, payload);
  }, [handleEditBase, stableMessages, conversationId]);

  const handleDelete = useCallback(async (messageId: string) => {
    await handleDeleteBase(messageId);
    if (!conversationId) return;
    conversationMessagesActions.applyDelete(conversationId, messageId);
  }, [handleDeleteBase, conversationId]);

  const handleRetry = useCallback(async () => {
    // regenerate() indexes into useChat's OWN local array (crashes if empty, throws
    // "not found" on an unknown id). Post-cutover nothing keeps that array in sync
    // with loaded history — the loads write the cache — so a Retry on a conversation
    // opened from history would act on an empty or stale transport copy. Seed it from
    // the settled rendered rows at the moment of the action (imperative,
    // user-action-scoped — NOT an effect syncing two containers, so rail 11 stands).
    // Skipped while our own send is live: the array is the mirror's read source then.
    if (!isOwnSendLive) {
      setMessages(stableMessages);
    }
    // Same computation the base handleRetry runs (against the same stableMessages
    // source) to decide which rows to DELETE server-side — computed BEFORE the base
    // call so we know what to remove from the cache once those deletes have gone out.
    const toRemove = getAssistantMessagesAfterLastUser(stableMessages).map((m) => m.id);
    await handleRetryBase();
    if (!conversationId) return;
    for (const id of toRemove) conversationMessagesActions.applyDelete(conversationId, id);
  }, [handleRetryBase, stableMessages, conversationId, isOwnSendLive, setMessages]);

  return { handleEdit, handleDelete, handleRetry, stableMessages };
}
