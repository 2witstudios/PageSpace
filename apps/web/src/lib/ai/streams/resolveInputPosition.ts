/**
 * Decides floating-input position ('centered' welcome state vs 'docked' at
 * the bottom) and latches 'docked' per conversationId once earned.
 *
 * `hasMessages`/`isLoading` alone flicker: mid-refetch there is a frame where
 * `isLoading` has already settled false but `hasMessages` has not yet turned
 * true (or vice-versa during a switch), which reads as "loaded and empty" for
 * a conversation that plainly has content — flashing the input to centered
 * and immediately back to docked. The latch remembers "this conversationId
 * has earned docked" so that transient frame can't un-dock it.
 *
 * The latch is keyed by conversationId specifically so a genuinely fresh,
 * empty conversation (New Chat) is unaffected by whatever the previous
 * conversation's latch said.
 *
 * Pure — no I/O, no side effects. Caller owns storing `latch` across renders.
 */
export type InputPosition = 'centered' | 'docked';

export interface InputPositionLatch {
  conversationId: string | null;
  docked: boolean;
}

export interface ResolveInputPositionResult {
  position: InputPosition;
  latch: InputPositionLatch;
}

export const resolveInputPosition = ({
  conversationId,
  isLoading,
  hasMessages,
  hasRemoteStreams,
  latch,
}: {
  conversationId: string | null;
  isLoading: boolean;
  hasMessages: boolean;
  hasRemoteStreams: boolean;
  latch: InputPositionLatch;
}): ResolveInputPositionResult => {
  const latchedDocked = latch.conversationId === conversationId && latch.docked;
  const docked = latchedDocked || hasMessages || isLoading || hasRemoteStreams;

  return {
    position: docked ? 'docked' : 'centered',
    latch: { conversationId, docked },
  };
};
