/**
 * Capture a fact about the CURRENT local stream when it appears, and hold it until the
 * stream ends — rather than following the surface, which moves independently of it.
 *
 * A stream's identity is fixed when it starts. The surface's conversation is not: `useChat`
 * only recreates its Chat when its `id` changes, and the agent/global surfaces use a constant
 * id — so switching conversation mid-stream does NOT abort the POST. The stream keeps running
 * while the surface's conversation moves out from under it.
 *
 * Keying stream ownership off the *live* conversation therefore migrated it: the running
 * stream's entry was cleared and a fresh claim was installed under a conversation with no
 * stream at all. The abandoned stream lost its Stop and its SWR protection while still
 * generating; the new key showed a Stop that aborted nothing — and the abort it did issue
 * named the wrong conversation, so the real stream kept billing.
 *
 * So: capture on the way in, hold for the stream's life, release on the way out.
 *
 * ── CALLER CONTRACT: `liveValue` MUST BE null UNTIL IT NAMES *THIS* STREAM ──────────────────
 *
 * This captures on the FIRST render where `isStreaming` is true. Callers derive `isStreaming`
 * from `status === 'submitted' || status === 'streaming'`, so that first render is a SUBMITTED
 * render — and at that moment useChat has NOT yet pushed this stream's assistant message. It
 * sets status='submitted' before issuing the request and pushes the message only inside
 * `write()`, which flips the status to 'streaming' in the same job.
 *
 * So during the submitted window, "the last assistant message in the array" is the PREVIOUS
 * TURN'S reply. Feeding that in as `liveValue` latched a message that had finished minutes ago
 * and held it for the whole stream: Stop then aborted an id the server registry no longer knew,
 * the local fetch stopped, the button LOOKED like it worked, and the real generation kept
 * running its write tools and kept billing — on every turn after the first.
 *
 * Hence the contract. For a messageId, pass `status === 'streaming' ? id : null` — never the id
 * derived from the looser `isStreaming`. Holding nothing is safe (callers fall back to the
 * chatId map, which is correct in that window); holding the WRONG thing is not.
 *
 * (An earlier version of this doc said the messageId is "captured when the first chunk
 * arrives". It is not, and that sentence is what the bug above was made of.)
 */
export const holdForStream = ({
  current,
  isStreaming,
  liveValue,
}: {
  /** What we captured previously (null when no stream is running). */
  current: string | null;
  /** Is a local stream in flight right now? */
  isStreaming: boolean;
  /**
   * The value to capture — but ONLY once it actually names THIS stream. See the caller
   * contract above: pass null while it does not, because we latch the first non-null value we
   * see and hold it for the whole stream.
   *
   * The conversationId is knowable immediately (the surface's own conversation at send time).
   * The assistant messageId is NOT: it does not exist until useChat reaches 'streaming', and
   * reading it any earlier yields the previous turn's reply.
   */
  liveValue: string | null | undefined;
}): string | null => {
  if (!isStreaming) return null;
  // Already captured: hold it, even if the surface has since moved on.
  if (current !== null) return current;
  return liveValue ?? null;
};
