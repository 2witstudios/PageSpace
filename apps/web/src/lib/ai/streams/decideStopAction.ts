import type { ActiveStream } from '@/lib/ai/streams/selectActiveStream';

/**
 * What the SERVER-side abort should name. The local `stop()` is not modelled here: callers run
 * it unconditionally before applying this decision (see below).
 */
export type StopAction =
  | { type: 'abortByMessageId'; messageId: string }
  | { type: 'abortByConversation'; conversationId: string }
  | { type: 'none' };

/**
 * Decides what a Stop click should name, for every surface.
 *
 * WHY THE LOCAL STOP IS NOT PART OF THIS DECISION.
 *
 * Callers call `rawStop()` (useChat's own stop) unconditionally, before applying this result —
 * the same order AiChatView already uses, and for the reason useChatStop's docblock gives: the
 * local stop is synchronous and purely local, while the server abort can now WAIT seconds to
 * find out whether a cross-instance owner actually stopped the generation. Running the local
 * stop first gives instant UI feedback and guarantees it strictly harder than a `finally` would.
 *
 * It is unconditional because it is a no-op in every case where it isn't wanted: `stop()` on a
 * useChat that is idle (a bootstrapped stream after a refresh, or a remote user's stream) does
 * nothing. Branching on ownership here would add a branch that no test could distinguish by
 * behaviour — so the ownership fact stays where it is actually used (rendering the Stop button
 * and the streaming indicator) rather than being threaded through a decision it cannot change.
 *
 * AND CANCELLING THE FETCH STOPS NOTHING ANYWAY. Streams are deliberately server-owned and
 * survive a client disconnect — that is the architecture. So a Stop that names nothing on the
 * server is a Stop that did nothing: the button flips back to Send while the generation keeps
 * running its write tools and keeps billing. Every branch below exists to make sure Stop can
 * always name something true.
 */
export const decideStopAction = ({
  activeStream,
  pendingSendConversationId,
}: {
  /** `selectActiveStream(...)` for the conversation on screen. */
  activeStream: ActiveStream | undefined;
  /** The conversation the in-flight send was made in (the pendingSend key), or null. */
  pendingSendConversationId: string | null;
}): StopAction => {
  // The precise name. Reaches the server registry even when the conversation shifted mid-stream,
  // and tears down any multicast SSE join via the resulting chat:stream_complete broadcast.
  if (activeStream) {
    return { type: 'abortByMessageId', messageId: activeStream.messageId };
  }

  // The submitted window: send clicked, no assistant message pushed yet, so no store entry and
  // no messageId exists anywhere. A real send spends 0.5-3s here (auth, rate limit, DB reads,
  // context assembly, connecting to the provider) — which is precisely when a user who has
  // spotted a typo hits Stop.
  //
  // The conversationId captured AT SEND is the one name the client holds from t=0. It is the
  // send-time id, never the surface's live id: a user who sends and immediately switches
  // conversation still has that generation running, and naming the surface's current
  // conversation would abort the wrong one — or nothing — while the real stream billed on.
  // (Server-side, an abort by conversation only ever stops the caller's OWN streams.)
  if (pendingSendConversationId) {
    return { type: 'abortByConversation', conversationId: pendingSendConversationId };
  }

  // Nothing live, nothing sent. Don't invent a name: an abort by a guessed conversation can only
  // report "nothing in flight", and would be a lie if it ever hit something.
  return { type: 'none' };
};
