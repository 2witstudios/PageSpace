import { extractTranscript, type TranscriptEntry } from './events';

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
  /** Whether the user is mid-utterance — distinct from being connected. */
  readonly userSpeaking: boolean;
  readonly transcript: readonly TranscriptEntry[];
  readonly tools: readonly ToolActivity[];
};

export const initialSessionState: SessionState = {
  status: 'idle',
  error: undefined,
  userSpeaking: false,
  transcript: [],
  tools: [],
};

export type SessionAction =
  | { readonly type: 'connecting' }
  | { readonly type: 'connected' }
  | { readonly type: 'failed'; readonly message: string }
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
      return { ...state, status: 'connecting', error: undefined };

    case 'connected':
      return { ...state, status: 'connected', error: undefined };

    case 'failed':
      // Keep the transcript: a drop mid-conversation must not erase the record.
      return {
        ...state,
        status: 'error',
        error: action.message,
        userSpeaking: false,
      };

    case 'disconnected':
      return { ...state, status: 'idle', userSpeaking: false };

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
