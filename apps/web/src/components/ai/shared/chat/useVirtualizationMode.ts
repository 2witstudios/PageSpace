import { useRef } from 'react';
import { selectVirtualizationMode } from '@/lib/ai/streams/selectVirtualizationMode';

/**
 * Holds a messages pane's virtualization mode across renders so that a *change*
 * of mode never lands mid-stream. See selectVirtualizationMode for why the
 * crossing is worth deferring.
 *
 * The ref is seeded from the first `desired` value, so an already-long
 * conversation virtualizes on its very first render; only later flips wait for
 * the stream to settle. Writing it during render is safe here because the
 * result is a pure function of (desired, isStreaming, previous) and re-running
 * converges on the same value, so a render React discards cannot strand it.
 */
export function useVirtualizationMode(desired: boolean, isStreaming: boolean): boolean {
  const currentRef = useRef(desired);
  const next = selectVirtualizationMode({ desired, isStreaming, current: currentRef.current });
  currentRef.current = next;
  return next;
}
