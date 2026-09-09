'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Loader2, Mic, MicOff } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useDriveStore } from '@/hooks/useDrive';
import { useVoiceBinding } from '@/hooks/voice/useVoiceBinding';
import { useVoiceSession, useVoiceSessionControls } from '@/contexts/VoiceSessionContext';
import { resolveLocationContext } from '@/lib/ai/shared/resolveLocationContext';
import { toVoiceLocationContext } from '@/lib/ai/realtime/voice-location';
import { describeCall, isCallLive } from '@/lib/ai/realtime/call-chrome';
import type { VoiceSurface } from '@/lib/ai/realtime/voice-binding';

export interface VoiceNavTriggerProps {
  /**
   * Bring the conversation the call is on into view. OPEN-ONLY — see
   * `decideReveal`. Given the surface because the dashboard needs no panel
   * opened at all: the conversation is already in the centre of the screen.
   */
  onReveal: (surface: VoiceSurface) => void;
  className?: string;
}

/**
 * THE one voice control, in the one piece of chrome that is on every route.
 *
 * It is a single button with two jobs and, deliberately, no third:
 *   - nothing running: start a call on whatever assistant is in view;
 *   - call running: it IS the live indicator, and pressing it brings that call
 *     back into view.
 *
 * IT NEVER HANGS UP. Ending a call is the call header's End button and only
 * that. A trigger that toggled would mean the live indicator is also the
 * destroy button — one control with two meanings, where the destructive one
 * fires on exactly the press a user makes when they want to see the call again.
 *
 * NOTHING CONNECTS UNTIL IT IS PRESSED. No microphone, no negotiation, no
 * permission prompt on page load — the whole voice stack is inert until this
 * button is used, which is why it can be mounted app-wide without cost.
 *
 * WHY IT RESOLVES THE LOCATION BEFORE STARTING. The tools' sense of place
 * reaches the model only when a call STARTS or CHAINS (see the KNOWN GAP note
 * in `VoiceSessionContext`), so a call opened before the location is known
 * answers "what's on this page?" about nowhere for its entire life. One resolve
 * ahead of a WebRTC handshake and a permission prompt is a latency cost that
 * buys the first spoken question actually working.
 */
export function VoiceNavTrigger({ onReveal, className }: VoiceNavTriggerProps) {
  const pathname = usePathname();
  // No `drives` SUBSCRIPTION: the list is read fresh from the store at press
  // time, below. Subscribing would re-render this button on every drive-store
  // write for a value it only needs once, at the moment it is used.
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  const { status, error, failure, attached, target, userSpeaking } = useVoiceSession();
  const { start, setLocationContext } = useVoiceSessionControls();
  const binding = useVoiceBinding();

  const [isStarting, setIsStarting] = useState(false);

  const chrome = describeCall({ status, error, failure, attached, bound: target !== null });
  const live = isCallLive(chrome.state);

  /**
   * The sidebar can be closed when a call fails, and the call header is the
   * only other thing that would report it — so a failure with the panel shut
   * would be a button that does nothing, forever, with no explanation. The
   * toast is what makes the microphone honest on every route.
   *
   * Keyed on the SENTENCE, not on `status`: two consecutive attempts that fail
   * the same way should not stack two identical toasts, and two that fail
   * differently must both be told.
   */
  const reportedRef = useRef<string | null>(null);
  /**
   * `handlePress` is declared below and the toast needs to call it, so the
   * toast's action reaches it through a ref rather than by hoisting the
   * callback above the effect that would then have to depend on it.
   */
  const pressRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (chrome.state !== 'error') {
      reportedRef.current = null;
      return;
    }
    const sentence = chrome.detail;
    if (sentence === null || reportedRef.current === sentence) return;
    reportedRef.current = sentence;
    toast.error(sentence, {
      // A Try again offered for a MISSING microphone is a button guaranteed to
      // fail — it teaches the user that voice is broken when the truth is that
      // they have no capture device. `canRetry` is that distinction, carried
      // all the way from `classifyMicFailure`.
      ...(chrome.canRetry
        ? { action: { label: 'Try again', onClick: () => pressRef.current() } }
        : {}),
    });
  }, [chrome.state, chrome.detail, chrome.canRetry]);

  const handlePress = useCallback(async () => {
    // Already up: this press is "show me the call", never "end it".
    if (live) {
      onReveal(binding.surface);
      return;
    }

    // The conversation for the assistant in view has not resolved yet. The
    // button is disabled in this state; this is the belt to that suspenders.
    if (binding.kind !== 'ready' || isStarting) return;

    onReveal(binding.surface);
    setIsStarting(true);
    try {
      // Drives are cached for five minutes, so this is usually free — but the
      // drive is half of what a location IS, and a call started before the
      // store populated would be permanently placeless.
      await fetchDrives();
      const { locationContext } = await resolveLocationContext(
        pathname,
        useDriveStore.getState().drives,
      );
      setLocationContext(toVoiceLocationContext(locationContext));
      await start(binding.target);
    } catch (error) {
      // Without this the spinner just stops and nothing else happens: a failure
      // BEFORE `start` runs never reaches `chrome.state === 'error'`, because
      // there is no call yet for the session to report an error on. The press
      // would look like it did nothing at all.
      //
      // It is also what keeps this off the unhandled-rejection path —
      // `pressRef` fires this with `void`, so a rejection had nowhere to go.
      toast.error('Could not start the call', {
        description: error instanceof Error ? error.message : 'Try again in a moment.',
      });
    } finally {
      setIsStarting(false);
    }
  }, [
    live,
    binding,
    isStarting,
    onReveal,
    fetchDrives,
    pathname,
    setLocationContext,
    start,
  ]);
  pressRef.current = () => void handlePress();

  const busy = chrome.state === 'connecting' || isStarting;
  // Disabled ONLY while the target is still resolving with nothing running.
  // Never disabled during a live call: that press is the way back to it.
  const disabled = !live && (binding.kind !== 'ready' || isStarting);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => void handlePress()}
      disabled={disabled}
      aria-label={chrome.label}
      aria-live="polite"
      data-testid="voice-nav-trigger"
      data-voice-state={chrome.state}
      data-voice-surface={binding.surface}
      className={cn('relative', className)}
    >
      {busy ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : chrome.state === 'error' ? (
        <MicOff className="h-5 w-5 text-destructive" />
      ) : (
        <Mic
          className={cn(
            'h-5 w-5',
            chrome.state === 'live' && 'text-primary',
            // Amber, not red: a call with no transcript is degraded, not broken,
            // and colouring it as a failure would tell the user to hang up a
            // call that is working.
            chrome.state === 'degraded' && 'text-amber-500',
          )}
        />
      )}

      {/*
        The live dot. Present for `live` AND `degraded` because both are calls
        in progress — whether the transcript is being written is what the colour
        says, not whether the microphone is open.
      */}
      {(chrome.state === 'live' || chrome.state === 'degraded') && (
        <span
          data-testid="voice-live-dot"
          className={cn(
            'absolute right-1 top-1 h-2 w-2 rounded-full',
            chrome.state === 'degraded' ? 'bg-amber-500' : 'bg-primary',
            userSpeaking && 'animate-pulse',
          )}
        />
      )}
    </Button>
  );
}
