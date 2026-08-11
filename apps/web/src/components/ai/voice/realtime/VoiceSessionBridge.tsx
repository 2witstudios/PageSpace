'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

import { useDriveStore } from '@/hooks/useDrive';
import { useVoiceBinding } from '@/hooks/voice/useVoiceBinding';
import { useVoiceRebindStore } from '@/stores/useVoiceRebindStore';
import { useVoiceSession, useVoiceSessionControls } from '@/contexts/VoiceSessionContext';
import { resolveLocationContext } from '@/lib/ai/shared/resolveLocationContext';
import { toVoiceLocationContext } from '@/lib/ai/realtime/voice-location';
import { rebindAction } from '@/lib/ai/realtime/voice-rebind';
import { describeCall, isCallLive } from '@/lib/ai/realtime/call-chrome';

/**
 * The two things that must happen to a live call while nobody is looking at it.
 *
 * Renders NOTHING, and that is the point. Both jobs below outlive every panel
 * that could show a call — the sidebar is unmounted outright when collapsed —
 * so neither can live in the chat surfaces. Mounted once, in `Layout`, beside
 * the trigger that is likewise on every route.
 *
 * ── 1. WHERE THE USER IS STANDING ────────────────────────────────────────────
 * Navigating updates `locationContext` and MUST NOT touch the session. This is
 * the effect that makes that true, and it is deliberately the ONLY thing in the
 * app that reacts to a route change with a live call running. It calls
 * `setLocationContext` and never `start` — a `start` here would be the settled
 * rule inverted, and the symptom would be a call that hangs up every time the
 * user opens a page.
 *
 * It runs only while a call is live. When nothing is running there is no
 * session to inform, and resolving a location on every navigation for every
 * user — two API calls a route — to serve a feature nobody has started would be
 * a cost paid by people who never press the microphone. The FIRST call's
 * location is resolved by the trigger, at press time, for the same reason.
 *
 * ── 2. FOLLOWING THE AGENT SWITCHER ──────────────────────────────────────────
 * The switcher records an intent (`useVoiceRebindStore`); this applies it once
 * the newly chosen agent's conversation has resolved. The decision itself is
 * `rebindAction`, which is pure and tested — including the case this whole
 * arrangement exists to make impossible, where a route change and a deliberate
 * switch look identical in the derived target.
 */
export function VoiceSessionBridge() {
  const pathname = usePathname();
  const drives = useDriveStore((state) => state.drives);

  const { status, error, failure, attached, target } = useVoiceSession();
  const { start, setLocationContext } = useVoiceSessionControls();

  const binding = useVoiceBinding();
  const intent = useVoiceRebindStore((state) => state.intent);
  const clearRebind = useVoiceRebindStore((state) => state.clearRebind);

  const chrome = describeCall({
    status,
    error,
    failure,
    attached,
    bound: target !== null,
  });
  const callIsLive = isCallLive(chrome.state);

  // 1. Location, while a call is live. No `start`, ever.
  useEffect(() => {
    if (!callIsLive) return;
    let ignore = false;

    void resolveLocationContext(pathname, drives).then(({ locationContext }) => {
      if (ignore) return;
      setLocationContext(toVoiceLocationContext(locationContext));
    });

    return () => {
      ignore = true;
    };
  }, [callIsLive, pathname, drives, setLocationContext]);

  // 2. The switcher's intent, applied when the app has caught up.
  useEffect(() => {
    const action = rebindAction(intent, binding, callIsLive);
    if (action.kind === 'wait') return;
    if (action.kind === 'clear') {
      clearRebind();
      return;
    }
    // Clear FIRST: `start` is async, and an intent still standing when this
    // effect re-runs on the resulting state change would ask for the same
    // rebind a second time.
    clearRebind();
    void start(action.target);
  }, [intent, binding, callIsLive, clearRebind, start]);

  return null;
}
