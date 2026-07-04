import { useEffect, useRef, useState } from 'react';

export type RunStatus = 'running' | 'error' | 'complete';

/**
 * Mirrors reasoning.tsx's AUTO_CLOSE_DELAY (apps/web/src/components/ai/ui/reasoning.tsx) —
 * declared independently so tool-run timing can be tuned without touching the
 * reasoning panel. Sequential tool calls in one agent turn produce a real
 * intermediate render where the currently-known parts are all complete before
 * the next call's part streams in; without this delay `status` bounces
 * complete -> running and the group visibly slide-collapses then slide-opens
 * once per step.
 */
const AUTO_COLLAPSE_DELAY = 1000;

/**
 * Starts open while `status` isn't 'complete'. Re-opens immediately whenever
 * status leaves 'complete'. Closes only after `status` has held at
 * 'complete' for AUTO_COLLAPSE_DELAY ms with no further transition — a
 * pending close is cancelled (not fired) if another tool call starts before
 * the delay elapses. All of this is skipped once the user has toggled
 * manually, in which case their choice is respected from then on.
 *
 * Needed because Radix's Collapsible only reads `defaultOpen` once at mount:
 * a run observed live (open while running/erroring) would otherwise never
 * collapse once it finishes, since the component doesn't remount when tool
 * state changes — it just re-renders with new props.
 */
export function useAutoCollapseOnComplete(status: RunStatus) {
  const [open, setOpen] = useState(() => status !== 'complete');
  const userToggledRef = useRef(false);
  const prevStatusRef = useRef(status);
  const hasAutoClosedRef = useRef(false);

  // Re-open immediately (and re-arm auto-close) whenever status leaves 'complete'.
  useEffect(() => {
    if (prevStatusRef.current !== status) {
      prevStatusRef.current = status;
      if (status !== 'complete' && !userToggledRef.current) {
        setOpen(true);
        hasAutoClosedRef.current = false;
      }
    }
  }, [status]);

  // Debounced auto-close: only fires after `status` has stayed 'complete' for
  // the full delay. Its cleanup (re-run whenever status/open change) cancels
  // the pending close the instant status flips back to running/error.
  useEffect(() => {
    if (status !== 'complete' || !open || userToggledRef.current || hasAutoClosedRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      setOpen(false);
      hasAutoClosedRef.current = true;
    }, AUTO_COLLAPSE_DELAY);
    return () => clearTimeout(timer);
  }, [status, open]);

  const onOpenChange = (next: boolean) => {
    userToggledRef.current = true;
    setOpen(next);
  };

  return { open, onOpenChange } as const;
}
