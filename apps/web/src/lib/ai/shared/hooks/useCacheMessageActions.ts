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
import { useCallback, useMemo, useRef } from 'react';
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
  /**
   * The surface's `useSendHandoff.wrapSend` — the SAME one its send uses.
   *
   * RETRY IS A SEND AND NOW GOES THROUGH SEND'S OPTIMISTIC PATH. It never did: `regenerate` was
   * called bare, so `pendingSendConversationId` stayed null, every surface's
   * `displayIsStreaming` stayed FALSE for the whole window, and the composer sat there with an
   * enabled textarea and a Send button while a regeneration was already under way. The one
   * visible change was the old assistant bubble vanishing — which reads as "something broke",
   * not "working on it". Send had complete optimistic UI the entire time; the two were never
   * meaningfully different in server work, only in feedback.
   *
   * Wrapped HERE rather than at each surface's regenerate adapter: this hook is the one shared
   * wrapper every surface already funnels retry through, so there is a single place to get it
   * right and nothing to drift. It also covers more than `regenerate` alone would — see
   * handleRetry.
   */
  wrapSend: <T>(sendFn: () => T) => T | undefined;
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
  wrapSend,
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

  // Latched for the whole retry, synchronously, before any await. Every other guard is
  // state-derived — planRetry's live-stream check, the button's `retryDisabled` — and state only
  // settles after a render, so a double-click lands both handlers inside the same await window
  // and fires TWO regenerations, billed twice.
  //
  // A SET KEYED BY CONVERSATION, not a boolean. The dashboard and sidebar keep one instance of
  // this hook across a conversation switch, and concurrent sends in different conversations are
  // supported by design — so a single flag let a retry still awaiting A's DELETEs silently
  // swallow a Retry click in B, for as long as A's requests took to settle. What must be
  // suppressed is a duplicate retry of the SAME conversation, which is what the key names.
  const retryInFlightConversationsRef = useRef<Set<string>>(new Set());

  const handleRetry = useCallback(async () => {
    // `conversationId` is null only before identity resolves, where handleRetryBase no-ops
    // anyway; one shared sentinel for that case cannot collide with a real cuid.
    const retryKey = conversationId ?? '\u0000no-conversation';
    if (retryInFlightConversationsRef.current.has(retryKey)) return;
    retryInFlightConversationsRef.current.add(retryKey);
    try {
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

      // THE OPTIMISTIC PATH, and it starts HERE — not around `regenerate` alone. handleRetryBase
      // has real network work to do before it can even issue the regenerate POST (it must delete
      // the superseded assistant rows server-side first; see its own comment for why that
      // ordering is load-bearing rather than incidental). Wrapping only the regenerate would
      // leave that whole round trip unfeedbacked — the exact dead window this is here to close.
      // From this call the surface's `displayIsStreaming` is true, so the composer locks and
      // offers Stop within a frame, same as a send.
      await wrapSend(() => handleRetryBase());
    } finally {
      retryInFlightConversationsRef.current.delete(retryKey);
    }
  }, [renderedMessages, handleRetryBase, conversationId, wrapSend]);

  return { handleEdit, handleDelete, handleRetry, stableMessages };
}
