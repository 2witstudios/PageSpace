import {
  extractFunctionCalls,
  extractTranscript,
  type TranscriptEntry,
} from '@pagespace/lib/realtime/voice-events';
import { describeToolCall } from '../tools/tool-labels';
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

/** One tool the model is off running right now, as the call bar says it. */
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
  /**
   * What the model is doing WHILE IT IS NOT TALKING — the dead air after "let
   * me check that", which was previously shown as nothing at all.
   *
   * Deliberately the tools running NOW rather than a log of every tool the call
   * has used. A growing list would pin the call bar's status line on the first
   * tool that ever ran, because that line prefers a tool over everything else;
   * and the history of the call belongs in the thread, which records it.
   */
  readonly activeTools: readonly ToolActivity[];
};

export const initialSessionState: SessionState = {
  status: 'idle',
  error: undefined,
  failure: undefined,
  userSpeaking: false,
  transcript: [],
  activeTools: [],
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
  | { readonly type: 'event'; readonly event: unknown };

const SPEECH_STARTED = 'input_audio_buffer.speech_started';
const SPEECH_STOPPED = 'input_audio_buffer.speech_stopped';
const RESPONSE_DONE = 'response.done';

/**
 * A tool call's arguments, for labelling only.
 *
 * The string is assembled from streamed deltas and is not guaranteed to parse.
 * A label is never worth throwing over inside a reducer, so a bad payload
 * simply costs the subject, not the label — `tool-dispatch.ts` owns the
 * recovery that matters, on the copy the tool actually runs against.
 */
const parseArguments = (argumentsJson: string): unknown => {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
};

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

    case 'event': {
      const type = eventType(action.event);
      if (type === SPEECH_STARTED) {
        return { ...state, userSpeaking: true };
      }
      if (type === SPEECH_STOPPED) {
        return { ...state, userSpeaking: false };
      }

      // A completed response is where a tool call is announced, and it is also
      // the moment the model stops talking — so it both starts the activity and
      // is the only place that can report there is none.
      if (type === RESPONSE_DONE) {
        const calls = extractFunctionCalls(action.event);
        const activeTools = calls.map((call) => ({
          name: call.name,
          speech: describeToolCall(call.name, parseArguments(call.argumentsJson)),
        }));
        // Cleared, not left alone, when a response carried no calls: that is the
        // model having finished a turn on its own.
        if (activeTools.length === 0 && state.activeTools.length === 0) return state;
        return { ...state, activeTools };
      }

      const entry = extractTranscript(action.event);
      // Same object back when nothing changed — an unrelated event must not
      // churn identity and re-render the UI.
      if (!entry) return state;
      return {
        ...state,
        transcript: [...state.transcript, entry],
        // The model is speaking again, so whatever it went away to do is done.
        // This is what bounds the status line to exactly the silent window.
        activeTools: state.activeTools.length === 0 ? state.activeTools : [],
      };
    }
  }
};
