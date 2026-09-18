'use client';

import { useRef } from 'react';
import {
  resolveInputPosition,
  type InputPosition,
  type InputPositionLatch,
} from './resolveInputPosition';

/**
 * Decides whether the floating composer renders 'centered' (new/empty
 * conversation welcome state) or 'docked' (bottom), latched per conversation
 * so a mid-refetch frame can't flash an occupied conversation back to
 * centered — see `resolveInputPosition` for the full rationale.
 *
 * `isBusy` covers the window between dispatching a send and the optimistic
 * stream/message appearing (pending-send handoff): it docks the composer
 * without conflating "busy" with content loading, so callers keep using
 * `isLoading` for spinner/disabled gating independently of position.
 *
 * The latch survives renders in a ref — it only ever gates a derived value
 * computed fresh every render, never itself triggers one.
 */
export function useInputPosition({
  conversationId,
  isLoading,
  hasMessages,
  hasRemoteStreams,
  isBusy = false,
}: {
  conversationId: string | null;
  isLoading: boolean;
  hasMessages: boolean;
  hasRemoteStreams: boolean;
  isBusy?: boolean;
}): InputPosition {
  const latchRef = useRef<InputPositionLatch>({ conversationId: null, docked: false });
  const { position, latch } = resolveInputPosition({
    conversationId,
    isLoading: isLoading || isBusy,
    hasMessages,
    hasRemoteStreams,
    latch: latchRef.current,
  });
  latchRef.current = latch;
  return position;
}
