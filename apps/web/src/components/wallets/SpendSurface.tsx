'use client';

import { createContext, useContext, useEffect, useId, useMemo, type ReactNode } from 'react';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { useSpendContextStore, type SpendContext } from '@/stores/useSpendContextStore';

const SpendSurfaceContext = createContext<SpendContext | null>(null);

/**
 * The conversation a chat surface spends for (Spec SPEND-3, UI-8). Every spend control inside the
 * surface — the composer strip, the refusal card in its error banner, the fallback notice under
 * its replies — reads its conversation from here, so a switch can only target THIS surface's
 * conversation, however many surfaces are mounted (review #2835 P1-1).
 *
 * The surface also registers with the header chip's registry and moves to the front when the
 * person focuses or clicks inside it, so the header follows focus explicitly.
 */
export function SpendSurfaceProvider({ conversationId, driveId, isGlobal, children }: { conversationId: string | null; driveId: string | null; isGlobal: boolean; children: ReactNode }) {
  const surfaceId = useId();
  const register = useSpendContextStore((s) => s.register);
  const unregister = useSpendContextStore((s) => s.unregister);
  const focus = useSpendContextStore((s) => s.focus);
  const value = useMemo(() => (conversationId ? { conversationId, driveId, isGlobal } : null), [conversationId, driveId, isGlobal]);

  // A changed conversation or drive updates this surface IN PLACE (register upserts); it does not
  // move it to the front of the header's focus order — only focus or a click does (P2-A).
  useEffect(() => {
    if (!ORGS_ENABLED) return;
    if (value) register(surfaceId, value);
    else unregister(surfaceId);
  }, [register, unregister, surfaceId, value]);
  useEffect(() => () => unregister(surfaceId), [unregister, surfaceId]);

  return (
    <SpendSurfaceContext.Provider value={value}>
      {/* display: contents keeps layout untouched while focus and clicks inside still reach it. */}
      <div className="contents" data-spend-surface={value?.conversationId} onFocusCapture={() => focus(surfaceId)} onPointerDownCapture={() => focus(surfaceId)}>
        {children}
      </div>
    </SpendSurfaceContext.Provider>
  );
}

/** The conversation of the surface this control is rendered in; null outside any surface. */
export function useSpendSurface(): SpendContext | null {
  return useContext(SpendSurfaceContext);
}
