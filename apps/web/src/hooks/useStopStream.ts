import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abortActiveStreamByConversation,
  abortActiveStreamByMessageId,
  reportAbortOutcome,
  type AbortResult,
} from '@/lib/ai/core/client';
import { ABORT_SETTLE_TIMEOUT_MS } from '@/lib/ai/core/stream-horizons';
import { decideStopAction } from '@/lib/ai/streams/decideStopAction';
import type { ActiveStream } from '@/lib/ai/streams/selectActiveStream';

/**
 * How long the "Stopping…" affordance may stay up with no resolution before it releases itself.
 *
 * It has to outlast the slowest HONEST Stop: a cross-instance abort waits up to
 * `ABORT_SETTLE_TIMEOUT_MS` (one watcher tick of phase error, the marked-row read, the parts
 * persist and the terminal write) and only THEN does `chat:stream_complete` get broadcast and
 * delivered. Doubling that buys the socket hop without inventing a second number.
 *
 * This is a backstop, not the mechanism. Every Stop that actually resolves clears on the socket
 * landing below, long before this fires; what it exists for is a socket that never arrives (a
 * dropped connection, an owning instance that died), where the alternative is a button stuck
 * spinning until unmount.
 */
export const STOPPING_FEEDBACK_TIMEOUT_MS = 2 * ABORT_SETTLE_TIMEOUT_MS;

export interface UseStopStreamResult {
  /** THE Stop action. */
  handleStop: () => Promise<void>;
  /**
   * A Stop has been requested and has not resolved yet. Render it as "stopping", NEVER as
   * "stopped": the reply is still streaming underneath and may keep streaming.
   */
  isStopping: boolean;
}

/**
 * THE Stop action, for every surface — and now the ONLY thing anywhere in the client that
 * stops a generation.
 *
 * All decision logic is in the pure, exhaustively tested `decideStopAction`; this hook is the
 * imperative shell that runs it. It names the stream by assistant `messageId` when one is
 * live, and falls back to the `conversationId` captured at send for the TTFB window, where the
 * server has not yet issued a messageId for the client to name.
 *
 * ── WHAT WAS REMOVED, AND WHY ITS ABSENCE IS THE FEATURE ──────────────────────────────────
 *
 * This used to run `rawStop()` FIRST — `useChat.stop()`, for "instant local feedback" while
 * the server abort round-tripped. It also had to decide WHETHER to run it, via
 * `shouldRunLocalStop` and the own-stream mirror's latch: with one `Chat` serving every
 * conversation, a Stop pressed on conversation A could otherwise abort conversation B's live
 * local fetch and send B dark mid-token while its generation carried on unwatched.
 *
 * Both are gone, and neither was replaced:
 *
 *   - `rawStop` itself. Cancelling a local read stops NOTHING. Streams are server-owned and
 *     survive client disconnect by design, so the only thing a local abort achieves is ending
 *     the run's VISIBLE life while it keeps generating, keeps calling write tools, and keeps
 *     billing. As "instant feedback" it was actively dishonest: the button flipped to Send
 *     over a generation that had not stopped. The store entry is what the button reads now,
 *     and it clears when the server actually confirms the stream is over.
 *   - `shouldRunLocalStop` and the latch it consulted. There is no shared `Chat` and no local
 *     read to protect, so the question "does this Stop belong to the fetch currently being
 *     read?" no longer has a referent.
 *
 * `only-a-deliberate-stop.test.ts` is the source-level tripwire that keeps a local stop from
 * being reintroduced, and it asserts that this path REACHES `/api/ai/abort` — because a Stop
 * that only cancels locally is indistinguishable, from the user's side, from one that works.
 *
 * ── `isStopping` — THE FEEDBACK THAT REPLACES IT, WITHOUT THE LIE ─────────────────────────
 *
 * Deleting `rawStop` was right, but it left the click with NOTHING to show for itself.
 * `reportAbortOutcome` is silent on every outcome but 'unconfirmed', so the resolved value of
 * the abort POST paints zero pixels; what actually clears the bubble and flips the composer is
 * the `chat:stream_complete` SOCKET event. So the screen sat unchanged for a full round trip —
 * up to `ABORT_SETTLE_TIMEOUT_MS` of deliberate server-side settle on a cross-instance owner —
 * plus socket delivery, with no acknowledgement that the press had registered at all. Users
 * read that as a hang, and press again.
 *
 * The distinction the old local stop got wrong is the whole design of this flag: it says
 * STOPPING, never STOPPED. It is set synchronously BEFORE the await so the button changes
 * within a frame, and it deliberately touches nothing else — the reply keeps streaming
 * underneath, the store entry stands, and `chat:stream_complete` remains the SOLE authority for
 * teardown. A requested Stop and an effective Stop are different facts, and claiming the second
 * while an agent is still calling write tools and still billing is the dishonesty that got
 * `rawStop` deleted.
 *
 * It is keyed to the CONVERSATION it was pressed for, and clears on four paths:
 *   - the socket landing — observed as that conversation's stop target disappearing (the store
 *     entry removed, the pendingSend resolved). That is the authority, read rather than
 *     duplicated.
 *   - the conversation being switched away from. These surfaces keep one hook instance across a
 *     switch, so a Stop on A must not disable B's Stop button.
 *   - any abort outcome that is not a confirmed `aborted` — see `releaseUnlessAbortConfirmed`.
 *   - `STOPPING_FEEDBACK_TIMEOUT_MS`, so a socket that never arrives cannot wedge the button.
 *
 * Between them they also cover the outcome that is silent BY DESIGN and had no feedback
 * whatsoever: 'not_found' — Stop pressed a beat after the reply ended — where the "Stopping…"
 * state appearing and then resolving is the acknowledgement the deliberately-quiet outcome code
 * cannot give.
 */
export const useStopStream = ({
  activeStream,
  pendingSendConversationId,
}: {
  /** `useConversationActiveStream(...)` for the conversation on screen. */
  activeStream: ActiveStream | undefined;
  /** `useSendHandoff`'s in-flight pendingSend key — the conversation captured AT SEND. */
  pendingSendConversationId: string | null;
}): UseStopStreamResult => {
  // WHICH CONVERSATION a Stop names — not merely WHETHER one is nameable.
  //
  // This was a boolean (`hasStopTarget`) and that was a bug: these surfaces keep ONE hook
  // instance across a conversation switch, so stopping A and then switching to B — which has
  // its own stream running — left the boolean true, the effect never fired, and B rendered a
  // disabled "Stopping…" button for a Stop nobody asked for, until the backstop expired. The
  // identity is what distinguishes the two, so the identity is what is tracked.
  //
  // Keyed by CONVERSATION rather than by messageId, because a Stop pressed in the TTFB window
  // names a conversation and only later acquires a messageId: keying on the message would make
  // the target "change" mid-abort and drop the affordance the moment the stream entry appeared.
  // Both branches of `decideStopAction` resolve to this same conversation, in the same order.
  const stopTargetConversationId =
    activeStream?.isOwn === true ? activeStream.conversationId : pendingSendConversationId;

  const [stoppingConversationId, setStoppingConversationId] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors the state for reads that happen AFTER an await, where the render-captured value is
  // a stale snapshot of a Stop that may since have been superseded.
  const stoppingConversationIdRef = useRef<string | null>(null);

  const raiseStopping = useCallback((conversationId: string) => {
    stoppingConversationIdRef.current = conversationId;
    setStoppingConversationId(conversationId);
  }, []);

  const clearStopping = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    stoppingConversationIdRef.current = null;
    setStoppingConversationId(null);
  }, []);

  /**
   * Release the affordance ONLY if it is still the one this Stop raised.
   *
   * Every release below happens after an await, and by then the user may have switched
   * conversation and pressed Stop again — at which point an unscoped `clearStopping()` would
   * wipe the SECOND Stop's feedback on the first one's late reply. Same failure family as the
   * conversation-keying above: anything this hook does after an await has to name what it is
   * acting on, because the hook outlives the conversation it was looking at.
   */
  const releaseStoppingFor = useCallback((conversationId: string | null) => {
    if (conversationId === null || stoppingConversationIdRef.current !== conversationId) return;
    clearStopping();
  }, [clearStopping]);

  // DERIVED, never stored: the affordance belongs to the conversation whose Stop was pressed, so
  // it can only show while that conversation is still the one on screen AND still has something
  // to stop. A mismatch is either the socket landing (the entry is gone) or a conversation
  // switch (the target is somebody else) — neither is a state this button may survive.
  const isStopping =
    stoppingConversationId !== null && stoppingConversationId === stopTargetConversationId;

  // Deriving above already makes the render honest a frame earlier than any effect could; this
  // is the cleanup half — it releases the backstop timer and the stored identity once they can
  // no longer describe anything.
  useEffect(() => {
    if (stoppingConversationId !== null && stoppingConversationId !== stopTargetConversationId) {
      clearStopping();
    }
  }, [stoppingConversationId, stopTargetConversationId, clearStopping]);

  // Unmount must not leave a timer holding a setState on a dead hook.
  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  /**
   * Hold the affordance ONLY on a positive confirmation that a stop is on its way.
   *
   * The abort helpers do not throw on failure — they resolve `{ code: 'unconfirmed' }` (see
   * NETWORK_FAILURE in stream-abort-client), which made the catch below unreachable for exactly
   * the case that most needs releasing: the user has just been TOLD the generation may still be
   * running and still billing, and the one control that could stop it was disabled for the whole
   * backstop. `not_found` is the mirror image — the server says nothing is running, so there is
   * nothing to be stopping. Only `aborted` means teardown is genuinely inbound, and only it
   * keeps waiting on `chat:stream_complete`.
   */
  const releaseUnlessAbortConfirmed = useCallback(
    (result: AbortResult, conversationId: string | null) => {
      if (result.code !== 'aborted') releaseStoppingFor(conversationId);
    },
    [releaseStoppingFor],
  );

  const handleStop = useCallback(async () => {
    // FIRST, synchronously, before any await: the click has to change the screen within a frame.
    // Says "stopping", never "stopped" — see the docblock. Nothing else here touches the
    // rendered stream.
    //
    // Nothing to name means nothing to claim: with no target there is no conversation to key the
    // affordance to, so it is never raised rather than raised and instantly withdrawn.
    const stoppedConversationId = stopTargetConversationId;
    if (stoppedConversationId !== null) {
      raiseStopping(stoppedConversationId);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        stoppingConversationIdRef.current = null;
        setStoppingConversationId(null);
      }, STOPPING_FEEDBACK_TIMEOUT_MS);
    }

    const action = decideStopAction({ activeStream, pendingSendConversationId });

    try {
      if (action.type === 'abortByMessageId') {
        const result = await abortActiveStreamByMessageId({ messageId: action.messageId });
        reportAbortOutcome(result);
        releaseUnlessAbortConfirmed(result, stoppedConversationId);
        return;
      }
      if (action.type === 'abortByConversation') {
        const result = await abortActiveStreamByConversation({
          conversationId: action.conversationId,
        });
        reportAbortOutcome(result);
        releaseUnlessAbortConfirmed(result, stoppedConversationId);
        return;
      }
      // 'none' — nothing live and nothing sent. Deliberately silent: there is nothing to report
      // and nothing to name, and nothing was raised above either.
    } catch (error) {
      // Kept for a genuinely unexpected throw (the helpers swallow network failure into
      // 'unconfirmed', which `releaseUnlessAbortConfirmed` handles). No socket is coming for it:
      // release now rather than making the user wait out the backstop — but only if this Stop's
      // affordance is still the one showing.
      releaseStoppingFor(stoppedConversationId);
      throw error;
    }
  }, [
    activeStream,
    pendingSendConversationId,
    stopTargetConversationId,
    raiseStopping,
    releaseUnlessAbortConfirmed,
    releaseStoppingFor,
  ]);

  return { handleStop, isStopping };
};
