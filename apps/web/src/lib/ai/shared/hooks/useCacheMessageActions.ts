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
import { useEditingStore } from '@/stores/useEditingStore';
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
  /**
   * The surface's `useSendHandoff.releasePendingSend` — the SAME one its send uses.
   *
   * Required because a retry can now decline to dispatch: a Stop pressed while the superseded
   * assistant rows are being deleted server-side has nothing for the server to abort (no stream
   * row exists yet), so `handleRetry` refuses to start the generation. That return path moves
   * none of the handoff effect's dependencies, and the composer renders only Stop while a
   * pendingSend stands — so without this the conversation would sit locked until unmount.
   */
  releasePendingSend: () => void;
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
  releasePendingSend,
}: UseCacheMessageActionsOptions): UseCacheMessageActionsResult {
  const stableMessages = useMemo(
    () => renderedMessages.filter((r) => r.mode !== 'streaming').map((r) => r.message),
    [renderedMessages],
  );

  // The LIVE conversation, for reads that happen after an await — where the closure's captured
  // `conversationId` is a snapshot of the retry, not of what is on screen now. See handleRetry's
  // release.
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

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
    // THE DUPLICATE-RETRY GUARD, and it is deliberately not local state.
    //
    // Every other guard is too late or too narrow. `planRetry`'s live-stream check and the
    // button's `retryDisabled` are both state-derived, and state only settles after a render —
    // so a double-click lands both handlers inside the same await window. A ref would close
    // that, but only per hook INSTANCE, and the dashboard and the sidebar each mount their own
    // for the same conversation: two Retry buttons, two refs, neither aware of the other.
    //
    // That is not a theoretical gap. The server's per-conversation takeover explicitly does not
    // close it — "two near-simultaneous sends can BOTH find zero in-flight rows and BOTH
    // proceed: two generations, two sets of tool calls, two bills" (stream-takeover.ts) — so
    // the client is the only place it can be closed.
    //
    // `useEditingStore.pendingSends` is already exactly this latch: app-wide, keyed by
    // conversation, and written by the very `wrapSend` below (synchronously, before it returns).
    // Reusing it rather than adding a second registry means there is one answer to "is a send in
    // flight for this conversation", and it inherits that store's release paths — including
    // wrapSend's safety timeout, so a hung DELETE cannot wedge Retry the way a bespoke latch of
    // our own would.
    //
    // A null `conversationId` needs no guard: `wrapSend` returns without calling its argument in
    // that case, so no retry can have started and none can be duplicated.
    if (conversationId && useEditingStore.getState().hasPendingSend(conversationId)) return;

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
    // Kept so the cache can be put back if the server deletes turn out not to have happened —
    // see the restore below. The rows themselves, not just their ids: an id cannot be un-deleted.
    const deletedRows = stableMessages.filter((m) => assistantIdsToDelete.includes(m.id));

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
    const outcome = await wrapSend(() => handleRetryBase());

    // `undefined` means `wrapSend` had no conversation to register under, so it never called its
    // argument and there is nothing here to undo. Everything below is about a retry that DID
    // register and then declined.
    if (!outcome || outcome.dispatched) return;

    // THE CACHE HAS TO BE PUT BACK when the server deletes did not happen. It was written
    // synchronously above so the superseded answer would disappear at the click, and that write
    // is now a claim the server does not agree with — which matters beyond cosmetics, because
    // the NEXT retry plans its deletes from this same cache. Leave it lying and that retry finds
    // nothing to delete, dispatches, and hands the model its own previous answer: the exact
    // corruption the refusal above just prevented, one click later.
    //
    // Only the rows the server STILL HOLDS, which is why the outcome names them. A partial
    // failure is the case that makes the distinction earn its keep: restoring the ones that did
    // delete would leave the cache claiming messages that no longer exist anywhere.
    if (outcome.reason === 'delete-failed' && conversationId) {
      for (const message of deletedRows) {
        if (!outcome.undeletedIds.includes(message.id)) continue;
        conversationMessagesActions.applyConfirmedMessage(conversationId, message);
      }
    }

    // Nothing else will clear the pendingSend on these paths: the handoff effect is keyed on
    // state they never moved, so the composer would show Stop until unmount.
    //
    // Scoped to the conversation this retry was for, like every other post-await step in this
    // epic. `releasePendingSend` names whatever conversation it was BUILT for but guards on a
    // ref shared across renders, so the stale copy this closure holds would happily release a
    // send belonging to the conversation the user has since switched to. If the surface has
    // moved on, `useSendHandoff`'s own conversation-change cleanup already released ours and
    // there is nothing here to do.
    if (conversationIdRef.current === conversationId) releasePendingSend();
  }, [renderedMessages, stableMessages, handleRetryBase, conversationId, wrapSend, releasePendingSend]);

  return { handleEdit, handleDelete, handleRetry, stableMessages };
}
