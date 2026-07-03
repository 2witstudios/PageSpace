import { useEffect, useRef, useState } from 'react';

export type RunStatus = 'running' | 'error' | 'complete';

/**
 * Starts open while `status` isn't 'complete', then auto-closes exactly once
 * when it transitions to 'complete' — unless the user has already toggled it
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

  useEffect(() => {
    if (prevStatusRef.current !== status) {
      prevStatusRef.current = status;
      if (!userToggledRef.current) {
        setOpen(status !== 'complete');
      }
    }
  }, [status]);

  const onOpenChange = (next: boolean) => {
    userToggledRef.current = true;
    setOpen(next);
  };

  return { open, onOpenChange } as const;
}
