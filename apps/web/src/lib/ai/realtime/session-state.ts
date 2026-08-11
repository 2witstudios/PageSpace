import { extractTranscript, type TranscriptEntry } from '@pagespace/lib/realtime/voice-events';
// Type-only, so no runtime edge is created from this pure module to the
// browser-side connector: the union is DEFINED there because that is where the
// failures are classified, and restating it here would be a second copy free to
// drift from the one `connect.ts` actually emits.
import type { VoiceConnectFailure } from './connect';

/**
 * Everything the voice UI shows, as a pure reducer. The hook owns the wiring;
 * it owns no decisions, so what appears on screen is testable without a
 * browser, a peer connection, or a microphone.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

export type ToolActivity = {
  readonly name: string;
  readonly speech: string;
};

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export type SessionState = {
  readonly status: ConnectionStatus;
  readonly error: string | undefined;
  /**
   * WHY the last attempt failed, classified — not merely the sentence shown.
   *
   * `error` alone cannot be branched on: a denied permission prompt and an
   * absent capture device are both "voice didn't start" as strings, and the UI
   * has to treat them oppositely (one is retryable in four seconds, the other
   * is not retryable at all). `connect.ts` already classifies every failure via
   * `classifyMicFailure`; carrying the classification out is what lets the
   * chrome offer — or withhold — a Try again that can actually work.
   */
  readonly failure: VoiceConnectFailure | undefined;
  /** Whether the user is mid-utterance — distinct from being connected. */
  readonly userSpeaking: boolean;
  readonly transcript: readonly TranscriptEntry[];
  readonly tools: readonly ToolActivity[];
};

export const initialSessionState: SessionState = {
  status: 'idle',
  error: undefined,
  failure: undefined,
  userSpeaking: false,
  transcript: [],
  tools: [],
};

export type SessionAction =
  | { readonly type: 'connecting' }
  | { readonly type: 'connected' }
  | {
      readonly type: 'failed';
      readonly message: string;
      /** Absent for failures with no classification — a dropped connection. */
      readonly failure?: VoiceConnectFailure;
    }
  | { readonly type: 'disconnected' }
  | { readonly type: 'event'; readonly event: unknown }
  | { readonly type: 'tool'; readonly name: string; readonly speech: string };

const SPEECH_STARTED = 'input_audio_buffer.speech_started';
const SPEECH_STOPPED = 'input_audio_buffer.speech_stopped';

const eventType = (event: unknown): string | undefined => {
  if (typeof event !== 'object' || event === null) {
    return undefined;
  }
  const type = (event as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
};

export const sessionReducer = (
  state: SessionState,
  action: SessionAction,
): SessionState => {
  switch (action.type) {
    case 'connecting':
      return { ...state, status: 'connecting', error: undefined, failure: undefined };

    case 'connected':
      return { ...state, status: 'connected', error: undefined, failure: undefined };

    case 'failed':
      // Keep the transcript: a drop mid-conversation must not erase the record.
      return {
        ...state,
        status: 'error',
        error: action.message,
        failure: action.failure,
        userSpeaking: false,
      };

    case 'disconnected':
      return { ...state, status: 'idle', userSpeaking: false, failure: undefined };

    case 'tool':
      return {
        ...state,
        tools: [...state.tools, { name: action.name, speech: action.speech }],
      };

    case 'event': {
      const type = eventType(action.event);
      if (type === SPEECH_STARTED) {
        return { ...state, userSpeaking: true };
      }
      if (type === SPEECH_STOPPED) {
        return { ...state, userSpeaking: false };
      }
      const entry = extractTranscript(action.event);
      // Same object back when nothing changed — an unrelated event must not
      // churn identity and re-render the UI.
      return entry
        ? { ...state, transcript: [...state.transcript, entry] }
        : state;
    }
  }
};
