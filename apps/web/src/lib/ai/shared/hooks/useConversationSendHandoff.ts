import { useCallback, useEffect, useRef } from 'react';

type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

/**
 * Bound on the settle wait so a never-settling status cannot wedge the composer. useChat's
 * stop() settles status in the abort's catch handler, which is prompt; this only fires if that
 * contract breaks. On timeout the handoff consults the mirror's latch: released → safe to send;
 * still held → prepareSend resolves false and the caller must abort the send.
 */
const SETTLE_TIMEOUT_MS = 1500;

/**
 * Enforces ONE live locally-consumed stream per `useChat` instance — the invariant the AI SDK
 * demands and nothing used to uphold.
 *
 * The SDK's `Chat` cannot consume two response bodies at once: a second `sendMessage` while one
 * is streaming overwrites `activeResponse` (the first stream's abortController becomes
 * unreachable — locally unstoppable), and the two streams' interleaved writes corrupt the shared
 * messages array (each re-pushes its live message whenever the other's is last). Downstream, the
 * own-stream mirror can only represent one send, so the second conversation's content got keyed
 * under the first conversation's id in usePendingStreamsStore — chat 1's stream rendering inside
 * chat 2.
 *
 * Every surface therefore calls `prepareSend(targetConversationId)` BEFORE sending. When the
 * chat is already consuming a stream for a DIFFERENT conversation, the in-flight stream is
 * handed off to the socket path — the normal representation of "my own stream this chat is not
 * consuming", identical to the post-refresh bootstrap case:
 *
 *   1. `stop()` — abort the local read. Streams are server-owned and survive client disconnect,
 *      so the generation continues; only this tab's consumption of it ends.
 *   2. Await status observed `ready`/`error`. This guarantees the mirror's falling edge (which
 *      releases its identity latch and removes the store entry) runs BEFORE the next send's
 *      rising edge — the single-latch design stays sound — and keeps the late `ready` from
 *      landing inside the next send's submitted window, where it would clear `useSendHandoff`'s
 *      pendingSend and cost Stop coverage for the TTFB window.
 *   3. Fire the socket rejoin (bootstrap). The consuming mark for the old conversation was
 *      released when the aborted body settled (`createStreamTrackingFetch`'s once-only guard,
 *      strictly before status settles), so the bootstrap attaches the old conversation's stream
 *      as a remote-rendered own stream, re-seeded from the server's persisted snapshot.
 *
 * Same-conversation sends and idle chats resolve immediately — the handoff only exists for the
 * cross-conversation-while-busy case.
 *
 * `prepareSend` resolves `true` when it is safe to send, `false` when it is not: the surface
 * unmounted mid-wait (nothing left to render or mirror the send), or the settle wait timed out
 * with the mirror's latch STILL held (sending would re-key the new stream under the old
 * conversation — the bug this hook prevents). Callers MUST abort the send on `false`.
 */
export const useConversationSendHandoff = ({
  status,
  stop,
  getLatchedConversationId,
  rejoin,
}: {
  /** The chat's live status — the same value the mirror watches. */
  status: ChatStatus;
  /** The chat's `useChat.stop` — aborts only THIS chat's local fetch. */
  stop: () => void;
  /** `useOwnStreamMirror`'s latch getter: which conversation this chat is consuming for, if any. */
  getLatchedConversationId: () => string | undefined;
  /** The channel socket's `rejoinActiveStreams` — re-bootstraps and attaches unconsumed own streams. */
  rejoin: () => void;
}): { prepareSend: (targetConversationId: string) => Promise<boolean> } => {
  const statusRef = useRef(status);
  statusRef.current = status;
  const settleResolversRef = useRef<((outcome: 'settled' | 'unmounted') => void)[]>([]);

  // Flush settle waiters when the status lands on ready/error. Runs after the same commit in
  // which the mirror's falling edge ran (all of a commit's effects flush before the awaiting
  // continuation's microtask), so by the time a waiter proceeds, the latch is already released.
  useEffect(() => {
    if (status !== 'ready' && status !== 'error') return;
    const resolvers = settleResolversRef.current;
    if (resolvers.length === 0) return;
    settleResolversRef.current = [];
    for (const resolve of resolvers) resolve('settled');
  }, [status]);

  useEffect(() => () => {
    // Unmount: release any waiters rather than leaving their sends pending forever. They resolve
    // as 'unmounted', which prepareSend reports as NOT safe to send — the surface is gone, and
    // nothing would render (or mirror) the send's outcome.
    const resolvers = settleResolversRef.current;
    settleResolversRef.current = [];
    for (const resolve of resolvers) resolve('unmounted');
  }, []);

  const prepareSend = useCallback(
    async (targetConversationId: string): Promise<boolean> => {
      const latched = getLatchedConversationId();
      // Idle chat (nothing latched), or a send into the conversation already being consumed —
      // no handoff. Bootstrapped/socket-attached streams never latch, so they never trigger one.
      // An empty-string latch is the mirror's unresolved-identity placeholder, never a real
      // send (same reasoning as useStopStream's rawStop gate) — don't hand off on garbage.
      if (latched === undefined || latched === '' || latched === targetConversationId) return true;

      stop();

      let outcome: 'settled' | 'timeout' | 'unmounted' = 'settled';
      if (statusRef.current !== 'ready' && statusRef.current !== 'error') {
        outcome = await new Promise<'settled' | 'timeout' | 'unmounted'>((resolve) => {
          const timer = setTimeout(() => {
            settleResolversRef.current = settleResolversRef.current.filter((r) => r !== wrapped);
            resolve('timeout');
          }, SETTLE_TIMEOUT_MS);
          const wrapped = (settleOutcome: 'settled' | 'unmounted') => {
            clearTimeout(timer);
            resolve(settleOutcome);
          };
          settleResolversRef.current.push(wrapped);
        });
      }

      if (outcome === 'unmounted') return false;

      // Timeout is NOT success by fiat (review finding, PR #2121): proceeding with the latch
      // still held would hand the NEW send the OLD conversation's identity — the exact
      // mis-keying this hook exists to prevent. The latch itself is the invariant, so consult
      // it: if the mirror released it despite the status flush lagging, the handoff is safe;
      // if it is still held, refuse the send (the caller aborts, the composer un-wedges, and a
      // retry re-attempts the handoff).
      if (outcome === 'timeout' && getLatchedConversationId() !== undefined) {
        console.warn(
          '[useConversationSendHandoff] chat status never settled after stop(); refusing the send',
        );
        return false;
      }

      // Fire-and-forget: the bootstrap's HTTP roundtrip must not delay the user's send. The
      // consuming mark was already released before status settled, so the bootstrap will attach
      // the handed-off conversation's stream; `chat:stream_start` covers a submitted-window
      // handoff whose stream row didn't exist yet, and the processed/skip guards cover a stream
      // that completed during the gap.
      rejoin();
      return true;
    },
    [getLatchedConversationId, stop, rejoin],
  );

  return { prepareSend };
};
