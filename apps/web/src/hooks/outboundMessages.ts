import type { UIMessage } from 'ai';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';

/**
 * THE messages a request carries for a conversation — one implementation, shared by every
 * surface, resolved from the store at call time.
 *
 * ── WHY THIS IS A SHARED FUNCTION AND NOT A PER-SURFACE REF ───────────────────────────────
 *
 * It was, briefly, a per-surface ref: each surface held `stableMessagesRef` and assigned it
 * from its own rendered list, and `useChatSession` took a parameterless `getBaseMessages()`.
 * Two of the four surfaces — `GlobalAssistantView` and `SidebarChatTab` — declared the ref and
 * never assigned it. Nothing failed to compile and no test caught it, because an empty array
 * is a valid array: those surfaces simply sent every message with NO history, regenerated
 * from nothing, and could not compose a persisted `ask_user` prompt (review: codex P1 on PR
 * #2410).
 *
 * The bug was not the omission, it was that the omission was possible. Wiring that each
 * surface has to remember, in a codebase where two of four forgot on the first attempt, is a
 * defect waiting on the next surface. So the resolver is one exported function keyed by
 * conversation, every surface passes it directly, and there is no per-surface state to get
 * wrong.
 *
 * ── WHAT COUNTS AS "SETTLED" ──────────────────────────────────────────────────────────────
 *
 * DB-confirmed rows plus this tab's optimistic sends, in that order — the same set the
 * surfaces render as non-streaming.
 *
 * `status: 'streaming'` rows are excluded, and that exclusion is deliberate rather than
 * incidental. Conversation loads carry `includeStreaming=1` so a history rejoin can see an
 * in-flight reply, so the cache legitimately holds half-written assistant placeholders. Such a
 * row is an INCOMPLETE message: sending it as history would hand the model a truncated
 * assistant turn, and — because `askUserAnswersComplete` inspects the LAST message — a
 * trailing placeholder would silently suppress the auto-resume after an `ask_user` answer.
 *
 * Optimistic sends are INCLUDED: the user's just-typed message is real, it is what the turn is
 * answering, and the server persists it before generating. Dropping it would send a request
 * whose last message is the previous turn.
 *
 * ── WHAT THE SERVER ACTUALLY DOES WITH THIS ───────────────────────────────────────────────
 *
 * Both chat routes are database-first: they read conversation history from the DB and use the
 * request's array only for the newest message (and, on a resume, for the client-side tool
 * results riding the last assistant message). So this array is not the model's context — it is
 * how the client names what it is sending. That is why correctness here shows up as a
 * *missing user message* or a *dead ask_user resume* rather than as an amnesiac model.
 */
export const getOutboundMessages = (conversationId: string | null): UIMessage[] => {
  if (!conversationId) return [];
  const entry = conversationMessagesActions.getEntry(conversationId);
  const settled = entry.messages.filter(
    (message) => (message as UIMessage & { status?: string }).status !== 'streaming',
  );
  return [...settled, ...entry.optimisticSends];
};
