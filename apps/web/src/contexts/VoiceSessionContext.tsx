'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  connectVoiceCall,
  type VoiceConnectDeps,
  type VoiceConnection,
} from '@/lib/ai/realtime/connect';
import {
  initialSessionState,
  sessionReducer,
  type SessionState,
} from '@/lib/ai/realtime/session-state';
import { chainDelayMs } from '@/lib/ai/realtime/chain-schedule';
import { decideBind, type VoiceTarget } from '@/lib/ai/realtime/voice-target';
import type { VoiceLocationContext } from '@pagespace/lib/realtime/voice-bridge-contract';

/**
 * THE voice session. One per app, above everything that can unmount.
 *
 * WHY IT LIVES IN `Layout` AND NOT IN THE SIDEBAR. `RightPanel` is unmounted
 * outright when the sidebar closes (`Layout.tsx`: `rightPanelVisible && …`), so
 * a session owned by the panel would hang up every time somebody collapsed it.
 * The sidebar is voice's HOME, not its OWNER — and that distinction is the
 * difference between a call you can walk away from and a call that is a
 * property of a panel.
 *
 * WHAT THIS OWNS: the peer connection, the microphone, the `<audio>` element the
 * model is heard through, the binding to a conversation, and the chain that
 * carries one conversation across the ceiling on a single call. Everything it
 * DECIDES lives in pure modules beside it — `sessionReducer` (what the UI
 * shows), `decideBind` (navigate vs rebind), `chainDelayMs` (when to hand off).
 * This file is the wiring, and it holds no decisions of its own.
 *
 * WHAT IT DOES NOT OWN: any UI. No button, no orb, no panel. The trigger and the
 * call chrome are a separate concern that consumes this provider through
 * `useVoiceSessionControls()` and `useVoiceSession()` — see the seam note at the
 * bottom of this file.
 *
 * LIFECYCLE, as settled:
 *  - Client-side navigation does NOT touch the session. Where the user is
 *    standing is `locationContext`, which travels with the call; where the user
 *    is TALKING is the conversation, which does not change because they walked
 *    to another page.
 *  - The agent switcher DOES rebind — a different agent is a different
 *    conversation with a different history, and no live session can serve it.
 *  - A hard refresh ends the call. That is deliberate: audio is ephemeral, the
 *    transcript in the thread is the artifact of record, and there is nothing to
 *    recover that the conversation does not already hold. There is no
 *    reconnect-on-load path here and there should not be one.
 */

export type VoiceSessionState = SessionState & {
  /** The conversation this session is speaking into, once bound. */
  readonly target: VoiceTarget | null;
  /** The `rtc_…` id of the call currently carrying the session. */
  readonly callId: string | null;
  /**
   * Whether the realtime server took this call. `false` means audio works but
   * tools, transcript persistence and metering do not — the UI is expected to
   * say so rather than imply full capability.
   */
  readonly attached: boolean;
  /** The user's own voice, for metering. Changes once per call, not per frame. */
  readonly localStream: MediaStream | null;
  /** The model's voice. Already routed to the speaker; here for visualisation. */
  readonly remoteStream: MediaStream | null;
};

export type VoiceSessionControls = {
  /**
   * Talk to this conversation. Idempotent for the target already bound — a
   * second press, or a re-render handing back the same target, must not restart
   * a call mid-sentence. A DIFFERENT target rebinds.
   */
  readonly start: (target: VoiceTarget) => Promise<void>;
  /** Hang up. Safe to call when nothing is running. */
  readonly stop: () => void;
  /**
   * Tell the session where the user is now standing. Does NOT rebind and does
   * not interrupt: navigating is not switching who you are talking to.
   */
  readonly setLocationContext: (
    locationContext: VoiceLocationContext | undefined,
  ) => void;
};

/** Test seam. Production passes nothing and gets the real browser APIs. */
export type VoiceSessionDeps = Pick<
  VoiceConnectDeps,
  'fetchImpl' | 'createPeerConnection' | 'getUserMedia' | 'createMediaStream'
>;

/**
 * Two tiers, following `GlobalChatContext`: the controls never change identity,
 * so a button that only starts and stops a call does not re-render on every
 * transcript line.
 */
const VoiceSessionStateContext = createContext<VoiceSessionState | undefined>(
  undefined,
);
const VoiceSessionControlsContext = createContext<
  VoiceSessionControls | undefined
>(undefined);

/**
 * One attempt at holding the call — a first connect or a chain. Identity is the
 * object itself: handlers close over their own attempt and compare against the
 * refs below, which is how the events of a call being replaced stay separate
 * from the events of the call replacing it, without either one guessing.
 */
type Attempt = {
  readonly target: VoiceTarget;
  connection: VoiceConnection | null;
  /** Held back until the swap when chaining, so the old call is not cut off. */
  remoteStream: MediaStream | null;
};

export function VoiceSessionProvider({
  children,
  deps,
}: {
  children: ReactNode;
  deps?: VoiceSessionDeps;
}) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const [target, setTarget] = useState<VoiceTarget | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** The attempt currently feeding the speaker and the UI. */
  const activeRef = useRef<Attempt | null>(null);
  /** The attempt being negotiated. A newer one supersedes it. */
  const pendingRef = useRef<Attempt | null>(null);
  /**
   * The target a live-or-connecting session is bound to. Held in a ref, not
   * read from state, because `start` must decide against what is true NOW —
   * a second press in the same tick would otherwise see a stale value and open
   * a second call.
   */
  const boundTargetRef = useRef<VoiceTarget | null>(null);
  const chainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Where the user is standing, kept current by navigation. Not state: it
   * changes on every route change and nothing renders from it.
   *
   * KNOWN GAP, stated rather than papered over: this reaches the model's tools
   * only when a call STARTS or CHAINS. The merged server exposes no hop for
   * updating a live call's context (`VOICE_BRIDGE_ROUTES` has `attach` and
   * nothing else), so between chains the tools answer "this page" with the page
   * the call started on. The fix belongs on the server contract — an update
   * route the realtime server applies to its held context — not to a client
   * that would otherwise have to fake it by rebinding, which is exactly the
   * behaviour the design forbids.
   */
  const locationRef = useRef<VoiceLocationContext | undefined>(undefined);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const beginAttemptRef = useRef<
    | ((target: VoiceTarget, options: { chained: boolean }) => Promise<void>)
    | null
  >(null);

  const clearChainTimer = useCallback(() => {
    if (chainTimerRef.current !== null) {
      clearTimeout(chainTimerRef.current);
      chainTimerRef.current = null;
    }
  }, []);

  /** Drop everything holding a microphone or a socket. Renders nothing. */
  const teardown = useCallback(() => {
    clearChainTimer();
    pendingRef.current?.connection?.stop();
    pendingRef.current = null;
    activeRef.current?.connection?.stop();
    activeRef.current = null;
    boundTargetRef.current = null;
  }, [clearChainTimer]);

  const clearSessionState = useCallback(() => {
    setCallId(null);
    setAttached(false);
    // Holding a stream whose tracks are stopped leaves anything metering it
    // tapping a dead graph.
    setLocalStream(null);
    setRemoteStream(null);
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
  }, []);

  /** Point the speaker at a stream. The only place `srcObject` is written. */
  const playRemote = useCallback((stream: MediaStream) => {
    if (audioRef.current) {
      audioRef.current.srcObject = stream;
    }
    setRemoteStream(stream);
  }, []);

  const beginAttempt = useCallback(
    async (
      nextTarget: VoiceTarget,
      options: { readonly chained: boolean },
    ): Promise<void> => {
      const previous = activeRef.current;
      const attempt: Attempt = {
        target: nextTarget,
        connection: null,
        remoteStream: null,
      };
      pendingRef.current = attempt;
      boundTargetRef.current = nextTarget;

      const result = await connectVoiceCall({
        ...depsRef.current,
        target: nextTarget,
        ...(locationRef.current === undefined
          ? {}
          : { locationContext: locationRef.current }),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // Chaining reuses the microphone already granted — cloned inside
        // `connect`, so stopping the outgoing call cannot take the incoming
        // call's audio with it — and starts silent so both sessions cannot hear
        // the same sentence during the moment they overlap.
        ...(options.chained && previous?.connection
          ? {
              microphone: previous.connection.microphone,
              microphoneEnabled: false,
            }
          : {}),
        onEvent: (event) => {
          // A chained call is silent until the swap; its events are not what
          // the user is hearing, and showing them would double the transcript.
          if (activeRef.current === attempt) {
            dispatch({ type: 'event', event });
          }
        },
        onRemoteTrack: (stream) => {
          attempt.remoteStream = stream;
          if (activeRef.current === attempt) playRemote(stream);
        },
        onConnectionLost: () => {
          // Only the call the user is actually on is a dropped call. A pending
          // chain that dies is handled by its own failure path, and the call it
          // was replacing is still up.
          if (activeRef.current !== attempt) return;
          teardown();
          clearSessionState();
          dispatch({ type: 'failed', message: 'The voice connection dropped.' });
        },
      });

      // Superseded while negotiating: a newer start, a rebind, or a hangup
      // happened. Whatever we just opened is not wanted — and must not be left
      // holding a microphone.
      if (pendingRef.current !== attempt) {
        if (result.ok) result.connection.stop();
        return;
      }
      pendingRef.current = null;

      if (!result.ok) {
        if (options.chained) {
          // The call being replaced is still live and still fine. Reporting a
          // failure here would be a lie about a working session; the server's
          // own cap will end it, and that surfaces as an ordinary drop.
          console.error(
            `[voice] chain failed, staying on the current call: ${result.detail}`,
          );
          return;
        }
        boundTargetRef.current = null;
        clearSessionState();
        setTarget(null);
        dispatch({ type: 'failed', message: result.message });
        return;
      }

      // The swap. The incoming call becomes the one being heard BEFORE the
      // outgoing one is stopped, so there is no moment with no session.
      activeRef.current = attempt;
      attempt.connection = result.connection;
      result.connection.setMicrophoneEnabled(true);
      if (attempt.remoteStream) playRemote(attempt.remoteStream);

      if (options.chained && previous?.connection) {
        previous.connection.stop();
      }

      setTarget(nextTarget);
      setCallId(result.connection.callId);
      setAttached(result.connection.attached);
      setLocalStream(result.connection.microphone);
      dispatch({ type: 'connected' });

      // Each call schedules its own successor from its own reported ceiling.
      clearChainTimer();
      const delay = chainDelayMs(result.connection.maxDurationMs);
      if (delay !== undefined) {
        chainTimerRef.current = setTimeout(() => {
          chainTimerRef.current = null;
          // Through a ref, because a chain is this function scheduling itself
          // and a callback cannot list itself as its own dependency.
          void beginAttemptRef.current?.(nextTarget, { chained: true });
        }, delay);
      }
    },
    [clearChainTimer, clearSessionState, playRemote, teardown],
  );
  beginAttemptRef.current = beginAttempt;

  const start = useCallback(
    async (nextTarget: VoiceTarget): Promise<void> => {
      const decision = decideBind(boundTargetRef.current, nextTarget);
      if (decision === 'none') return;

      if (decision === 'rebind') {
        // A deliberate switch: the old conversation's call has nothing to do
        // with the new one, so it goes before the new one is opened.
        teardown();
        clearSessionState();
      }

      setTarget(nextTarget);
      dispatch({ type: 'connecting' });
      await beginAttempt(nextTarget, { chained: false });
    },
    [beginAttempt, clearSessionState, teardown],
  );

  const stop = useCallback(() => {
    teardown();
    clearSessionState();
    setTarget(null);
    dispatch({ type: 'disconnected' });
  }, [clearSessionState, teardown]);

  const setLocationContext = useCallback(
    (locationContext: VoiceLocationContext | undefined) => {
      locationRef.current = locationContext;
    },
    [],
  );

  // Unmounting the provider means the app is going away (a hard refresh, a sign
  // out). Leaving here without this keeps the microphone live in a page nobody
  // is looking at.
  useEffect(() => teardown, [teardown]);

  const stateValue: VoiceSessionState = useMemo(
    () => ({
      ...state,
      target,
      callId,
      attached,
      localStream,
      remoteStream,
    }),
    [state, target, callId, attached, localStream, remoteStream],
  );

  const controlsValue: VoiceSessionControls = useMemo(
    () => ({ start, stop, setLocationContext }),
    [start, stop, setLocationContext],
  );

  return (
    <VoiceSessionStateContext.Provider value={stateValue}>
      <VoiceSessionControlsContext.Provider value={controlsValue}>
        {/*
          THE speaker. Rendered here rather than by whatever chrome is on screen
          because the call outlives every panel that could show it — a sink that
          unmounts with the sidebar would silence the model the moment somebody
          collapsed it.
        */}
        <audio
          ref={audioRef}
          autoPlay
          data-testid="voice-session-audio"
          className="sr-only"
        />
        {children}
      </VoiceSessionControlsContext.Provider>
    </VoiceSessionStateContext.Provider>
  );
}

/**
 * What the call is doing. Re-renders as the conversation moves — use it for the
 * orb, the live transcript, the connection state.
 */
export function useVoiceSession(): VoiceSessionState {
  const context = useContext(VoiceSessionStateContext);
  if (!context) {
    throw new Error('useVoiceSession must be used within a VoiceSessionProvider');
  }
  return context;
}

/**
 * How to start and stop it. Stable identity — a trigger that only starts a call
 * does not re-render as the call talks.
 *
 * ── THE SEAM FOR THE VOICE UI (chunk C-D) ────────────────────────────────────
 * Everything on screen is built on these two hooks and nothing else:
 *   - a trigger, anywhere on any route, calls
 *     `start({ conversationId, type, contextId?, agentPageId? })`;
 *   - the agent switcher calls `start(…)` with the new agent's target and gets a
 *     rebind for free — it does not stop and start;
 *   - route changes call `setLocationContext(…)` and MUST NOT call `start`;
 *   - call chrome reads `useVoiceSession()` for `status`, `error`, `transcript`,
 *     `userSpeaking`, `tools`, `attached` and the two streams.
 * The `<audio>` element and the microphone belong to this provider. UI that
 * mounts its own sink, or that owns a session per panel, is the failure mode
 * this file exists to prevent.
 */
export function useVoiceSessionControls(): VoiceSessionControls {
  const context = useContext(VoiceSessionControlsContext);
  if (!context) {
    throw new Error(
      'useVoiceSessionControls must be used within a VoiceSessionProvider',
    );
  }
  return context;
}
