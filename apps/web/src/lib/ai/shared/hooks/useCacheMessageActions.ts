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
import { planRetry } from '@/lib/ai/streams/planRetry';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import type { RenderedMessage } from '@/lib/ai/streams/selectRenderedMessages';

export interface UseCacheMessageActionsOptions {
  /** For agent mode: the agent/page ID. For global mode: null. */
  agentId: string | null;
  conversationId: string | null;
  /** The full rendered list (selectRenderedMessages output, mode included). */
  renderedMessages: RenderedMessage[];
  regenerate: (options?: { body?: Record<string, unknown> }) => void;
}

/**
 * TWO THINGS THIS HOOK USED TO DO AND NO LONGER NEEDS TO.
 *
 * `prepareSend` — Retry is a send, and under the shared-`Chat` design a Retry issued for the
 * conversation on screen while the chat consumed ANOTHER conversation's stream would re-send
 * the other conversation's transport trail under this conversation's body. That was a
 * cross-conversation content leak, and the handoff ran before the destructive steps so a
 * refusal deleted nothing. `useChatSession` has no shared instance and no shared trail —
 * `regenerate` sends the store's view of THIS conversation — so there is nothing to hand off
 * and nothing to refuse.
 *
 * `hydrateTransportBeforeReinvoke` + `getIsOwnSendLive` — `regenerate` indexed into useChat's
 * own array, which was empty after a reload, so the settled rows had to be copied in first;
 * and that copy had to be skipped while a send was live (the array was the mirror's read
 * source), which meant reading liveness AFTER the handoff settled rather than from the
 * render-captured prop. All of it existed to keep two stateful containers agreeing. There is
 * now one: the store.
 */

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
    regenerate,
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
    // planRetry is the guard: it plans nothing (no ids, no lastUserMessage) while a
    // stream is live anywhere in the rendered list, so an in-flight run can never be
    // deleted out from under itself. No user turn to retry from is the same no-op.
    const { assistantIdsToDelete, lastUserMessage } = planRetry(renderedMessages);
    if (!lastUserMessage) return;

    // Delete BEFORE awaiting handleRetryBase, not after: its underlying `regenerate` is a
    // real Promise that resolves once the new stream finishes (the ai SDK's makeRequest
    // reads the response to completion), so awaiting it first would leave the old assistant
    // rows visible in the cache/UI alongside the new streaming reply for the whole
    // regeneration (PR 6 review, CodeRabbit).
    if (conversationId) {
      for (const id of assistantIdsToDelete) conversationMessagesActions.applyDelete(conversationId, id);
    }
    await handleRetryBase();
  }, [renderedMessages, handleRetryBase, conversationId]);

  return { handleEdit, handleDelete, handleRetry, stableMessages };
}
