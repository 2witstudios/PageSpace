import { useCallback, useEffect, useRef } from 'react';

type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

/**
 * If the settle wait somehow never observes ready/error, proceed anyway rather than wedging the
 * composer. useChat's stop() settles status in the abort's catch handler, which is prompt; this
 * only fires if that contract breaks.
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
}): { prepareSend: (targetConversationId: string) => Promise<void> } => {
  const statusRef = useRef(status);
  statusRef.current = status;
  const settleResolversRef = useRef<(() => void)[]>([]);

  // Flush settle waiters when the status lands on ready/error. Runs after the same commit in
  // which the mirror's falling edge ran (all of a commit's effects flush before the awaiting
  // continuation's microtask), so by the time a waiter proceeds, the latch is already released.
  useEffect(() => {
    if (status !== 'ready' && status !== 'error') return;
    const resolvers = settleResolversRef.current;
    if (resolvers.length === 0) return;
    settleResolversRef.current = [];
    for (const resolve of resolvers) resolve();
  }, [status]);

  useEffect(() => () => {
    // Unmount: release any waiters rather than leaving their sends pending forever.
    const resolvers = settleResolversRef.current;
    settleResolversRef.current = [];
    for (const resolve of resolvers) resolve();
  }, []);

  const prepareSend = useCallback(
    async (targetConversationId: string): Promise<void> => {
      const latched = getLatchedConversationId();
      // Idle chat (nothing latched), or a send into the conversation already being consumed —
      // no handoff. Bootstrapped/socket-attached streams never latch, so they never trigger one.
      if (latched === undefined || latched === targetConversationId) return;

      stop();

      if (statusRef.current !== 'ready' && statusRef.current !== 'error') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            settleResolversRef.current = settleResolversRef.current.filter((r) => r !== wrapped);
            console.warn(
              '[useConversationSendHandoff] chat status never settled after stop(); proceeding',
            );
            resolve();
          }, SETTLE_TIMEOUT_MS);
          const wrapped = () => {
            clearTimeout(timer);
            resolve();
          };
          settleResolversRef.current.push(wrapped);
        });
      }

      // Fire-and-forget: the bootstrap's HTTP roundtrip must not delay the user's send. The
      // consuming mark was already released before status settled, so the bootstrap will attach
      // the handed-off conversation's stream; `chat:stream_start` covers a submitted-window
      // handoff whose stream row didn't exist yet, and the processed/skip guards cover a stream
      // that completed during the gap.
      rejoin();
    },
    [getLatchedConversationId, stop, rejoin],
  );

  return { prepareSend };
};
