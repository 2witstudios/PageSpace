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
 * Callers call `rawStop()` (useChat's own stop) before applying this result — the same order
 * AiChatView already uses, and for the reason useChatStop's docblock gives: the local stop is
 * synchronous and purely local, while the server abort can now WAIT seconds to find out whether
 * a cross-instance owner actually stopped the generation. Running the local stop first gives
 * instant UI feedback and guarantees it strictly harder than a `finally` would.
 *
 * It used to be UNCONDITIONAL, because `stop()` on an idle useChat is a no-op and the chat could
 * not be busy with anything but the conversation being stopped. Conversation-scoped consuming
 * (the dual-stream fix) broke that: the same chat instance can be locally consuming conversation
 * B's stream while conversation A's handed-off stream renders via the socket on this surface, and
 * a Stop on A must not abort B's live local fetch. `useStopStream` gates `rawStop` on the
 * mirror's latched conversation for exactly that case; the SERVER-side decision below is
 * unchanged — it names streams by store entry / send-time conversation, never by the local fetch.
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
  // OUR OWN live stream: the precise name. Reaches the server registry even when the conversation
  // shifted mid-stream, and tears down any multicast SSE join via the resulting
  // chat:stream_complete broadcast.
  if (activeStream?.isOwn) {
    return { type: 'abortByMessageId', messageId: activeStream.messageId };
  }

  // The submitted window: send clicked, no assistant message pushed yet, so no store entry of our
  // own and no messageId exists anywhere. A real send spends 0.5-3s here (auth, rate limit, DB
  // reads, context assembly, connecting to the provider) — which is precisely when a user who has
  // spotted a typo hits Stop.
  //
  // Checked BEFORE any remote stream, and this ordering is the whole point. On a shared
  // conversation a remote stream can be live in the store while our own send is still in its
  // submitted window (`useSendHandoff` is passed `isOwn === true` for exactly this reason). Naming
  // the remote stream's messageId there would abort *nothing*: the server's abort-by-messageId is
  // scoped to the calling user, so someone else's stream resolves to zero rows and reports
  // 'not_found' — on which `reportAbortOutcome` is deliberately SILENT. The button would flip back
  // to Send while our generation kept running its write tools and kept billing.
  //
  // The conversationId captured AT SEND is the one name the client holds from t=0. It is the
  // send-time id, never the surface's live id: a user who sends and immediately switches
  // conversation still has that generation running, and naming the surface's current conversation
  // would abort the wrong one — or nothing. (Server-side, an abort by conversation only ever stops
  // the caller's OWN streams.)
  if (pendingSendConversationId) {
    return { type: 'abortByConversation', conversationId: pendingSendConversationId };
  }

  // Nothing OF OURS is live and nothing was sent. A remote stream may well be running here, but it
  // is not ours to stop — the server would refuse it anyway (abort is user-scoped), and the
  // surfaces do not offer a Stop button for someone else's stream. Don't invent a name.
  return { type: 'none' };
};
