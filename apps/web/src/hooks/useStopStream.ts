import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abortActiveStreamByConversation,
  abortActiveStreamByMessageId,
  reportAbortOutcome,
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
 * It clears on three paths, and only these:
 *   - the socket landing — observed as the stop TARGET disappearing (the store entry removed,
 *     the pendingSend resolved). That is the authority, read rather than duplicated.
 *   - an error reaching the abort endpoint.
 *   - `STOPPING_FEEDBACK_TIMEOUT_MS`, so a socket that never arrives cannot wedge the button.
 *
 * It also covers the outcome that is silent BY DESIGN and had no feedback whatsoever:
 * 'not_found' — Stop pressed a beat after the reply ended — where the "Stopping…" state
 * resolving is the acknowledgement the deliberately-quiet outcome code cannot give.
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
  const [isStopping, setIsStopping] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearStopping = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsStopping(false);
  }, []);

  // Is there still anything for this Stop to be stopping? Exactly the two things
  // `decideStopAction` can name — our own live store entry, and the in-flight send's captured
  // conversation. When BOTH are gone the stream has been torn down, which on the abort path
  // happens because `chat:stream_complete` landed and removed the entry. So this IS the socket
  // landing, observed through the one place a live stream is recorded rather than by
  // second-guessing it with a socket subscription of our own.
  const hasStopTarget = activeStream?.isOwn === true || pendingSendConversationId !== null;

  // `isStopping` is in the deps, not just `hasStopTarget`, and that is load-bearing: on an
  // already-finished stream there is no target at the moment of the click, so a
  // `[hasStopTarget]`-only effect never re-runs and the affordance hangs until the backstop.
  // Depending on the flag itself means the very act of raising it schedules its own resolution.
  useEffect(() => {
    if (isStopping && !hasStopTarget) clearStopping();
  }, [isStopping, hasStopTarget, clearStopping]);

  // Unmount (and conversation switch, which unmounts the surface's chat) must not leave a timer
  // holding a setState on a dead hook.
  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const handleStop = useCallback(async () => {
    // FIRST, synchronously, before any await: the click has to change the screen within a frame.
    // Says "stopping", never "stopped" — see the docblock. Nothing else here touches the
    // rendered stream.
    setIsStopping(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      setIsStopping(false);
    }, STOPPING_FEEDBACK_TIMEOUT_MS);

    const action = decideStopAction({ activeStream, pendingSendConversationId });

    try {
      if (action.type === 'abortByMessageId') {
        reportAbortOutcome(await abortActiveStreamByMessageId({ messageId: action.messageId }));
        return;
      }
      if (action.type === 'abortByConversation') {
        reportAbortOutcome(
          await abortActiveStreamByConversation({ conversationId: action.conversationId }),
        );
        return;
      }
      // 'none' — nothing live and nothing sent. Deliberately silent: there is nothing to report
      // and nothing to name. The stopping state releases itself on the next render, because
      // 'none' is returned for exactly the state in which `hasStopTarget` is already false.
    } catch (error) {
      // The abort helpers swallow network failure into an 'unconfirmed' AbortResult, so this is
      // the unexpected-throw path. Whatever it was, no socket is coming for it: release the
      // affordance now rather than making the user wait out the backstop.
      clearStopping();
      throw error;
    }
  }, [activeStream, pendingSendConversationId, clearStopping]);

  return { handleStop, isStopping };
};
