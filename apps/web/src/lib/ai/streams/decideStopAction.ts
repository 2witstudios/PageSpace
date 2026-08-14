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
 * THERE IS NO LOCAL STOP TO DECIDE ABOUT ANY MORE.
 *
 * Callers used to run `rawStop()` — useChat's own stop — before applying this result, for
 * "instant UI feedback" while the server abort round-tripped. `useStopStream` even had to
 * decide WHETHER to run it, because one shared `Chat` meant a Stop on conversation A could
 * abort conversation B's live local read. Both are gone: this client reads no response body,
 * so there is no local fetch to cancel and no gate to get right.
 *
 * CANCELLING A FETCH STOPS NOTHING ANYWAY. Streams are deliberately server-owned and
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
