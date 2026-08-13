import { describe, expect, it } from 'vitest';
import {
  initialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from '../session-state';

const after = (
  actions: SessionAction[],
  from: SessionState = initialSessionState,
): SessionState => actions.reduce(sessionReducer, from);

/** A `response.done` announcing one tool call, as OpenAI shapes it. */
const toolCall = (name: string, args: Record<string, unknown>): SessionAction => ({
  type: 'event',
  event: {
    type: 'response.done',
    response: {
      output: [
        { type: 'function_call', call_id: 'c1', name, arguments: JSON.stringify(args) },
      ],
    },
  },
});

const said = (type: string, transcript: string): SessionAction => ({
  type: 'event',
  event: { type, transcript },
});

const SPEAKING: SessionAction = {
  type: 'event',
  event: { type: 'input_audio_buffer.speech_started' },
};
const STOPPED: SessionAction = {
  type: 'event',
  event: { type: 'input_audio_buffer.speech_stopped' },
};

describe('initialSessionState', () => {
  it('given nothing has happened, should be idle and empty', () => {
    expect(initialSessionState).toEqual({
      status: 'idle',
      error: undefined,
      userSpeaking: false,
      transcript: [],
      activeTools: [],
    });
  });
});

describe('connection lifecycle', () => {
  it('given a start, should move to connecting and clear any old error', () => {
    const state = after([
      { type: 'failed', message: 'old' },
      { type: 'connecting' },
    ]);
    expect(state.status).toBe('connecting');
    expect(state.error).toBeUndefined();
  });

  it('given success, should move to connected', () => {
    expect(after([{ type: 'connecting' }, { type: 'connected' }]).status).toBe(
      'connected',
    );
  });

  it('given a session that failed and reconnected, should clear the error', () => {
    const state = after([
      { type: 'failed', message: 'boom' },
      { type: 'connected' },
    ]);
    expect(state.error).toBeUndefined();
  });

  it('given a failure, should record the message and stop listening', () => {
    expect(after([SPEAKING, { type: 'failed', message: 'mic denied' }])).toMatchObject(
      { status: 'error', error: 'mic denied', userSpeaking: false },
    );
  });

  it('given a failure mid-conversation, should keep the transcript', () => {
    const state = after([
      said('conversation.item.input_audio_transcription.completed', 'hello'),
      said('response.output_audio_transcript.done', 'hi there'),
      { type: 'failed', message: 'dropped' },
    ]);
    expect(state.transcript).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ]);
  });

  it('given a call that ends or restarts, should stop claiming a tool is running', () => {
    // A dropped call is not still reading a page. Left alone, the next call
    // would open showing the previous call's tool as live for its whole first
    // silent turn.
    for (const ending of [
      { type: 'failed', message: 'dropped' },
      { type: 'disconnected' },
      { type: 'connecting' },
      { type: 'connected' },
    ] as SessionAction[]) {
      const state = after([toolCall('read_page', { title: 'Notes' }), ending]);
      expect(state.activeTools, `${ending.type} left a stale tool`).toEqual([]);
    }
  });

  it('given a disconnect, should return to idle and stop listening', () => {
    expect(
      after([{ type: 'connected' }, SPEAKING, { type: 'disconnected' }]),
    ).toMatchObject({ status: 'idle', userSpeaking: false });
  });

  it('given a disconnect after a conversation, should keep the transcript', () => {
    const state = after([
      said('conversation.item.input_audio_transcription.completed', 'hello'),
      { type: 'disconnected' },
    ]);
    expect(state.transcript).toHaveLength(1);
  });
});

describe('listening state', () => {
  it('given speech starts, should mark the user as speaking', () => {
    expect(after([SPEAKING]).userSpeaking).toBe(true);
  });

  it('given speech stops, should clear it', () => {
    expect(after([SPEAKING, STOPPED]).userSpeaking).toBe(false);
  });

  it('given connection state, should stay independent of listening state', () => {
    const state = after([{ type: 'connected' }, SPEAKING]);
    expect(state.status).toBe('connected');
    expect(state.userSpeaking).toBe(true);
  });
});

describe('transcript', () => {
  it('given both sides speaking, should record them in order', () => {
    const state = after([
      said('conversation.item.input_audio_transcription.completed', 'read my notes'),
      said('response.output_audio_transcript.done', 'Here they are.'),
    ]);
    expect(state.transcript).toEqual([
      { role: 'user', text: 'read my notes' },
      { role: 'assistant', text: 'Here they are.' },
    ]);
  });

  it('given the older assistant event name, should record it the same way', () => {
    expect(
      after([said('response.audio_transcript.done', 'Here they are.')]).transcript,
    ).toEqual([{ role: 'assistant', text: 'Here they are.' }]);
  });

  it('given an irrelevant event, should return the same state object', () => {
    const start = initialSessionState;
    expect(sessionReducer(start, { type: 'event', event: { type: 'x' } })).toBe(
      start,
    );
  });

  it('given a non-object event, should not throw', () => {
    const start = initialSessionState;
    expect(sessionReducer(start, { type: 'event', event: null })).toBe(start);
    expect(sessionReducer(start, { type: 'event', event: 'nope' })).toBe(start);
  });

  it('given an event with a non-string type, should not throw', () => {
    const start = initialSessionState;
    expect(sessionReducer(start, { type: 'event', event: { type: 7 } })).toBe(
      start,
    );
  });
});

describe('tool activity — what fills the silence', () => {
  it('given a response announcing a tool call, should say what is running', () => {
    // This is the whole point: between "let me check that" and the answer, the
    // model is silent and the bar used to show nothing.
    const state = after([toolCall('read_page', { title: 'Roadmap' })]);

    expect(state.activeTools).toEqual([{ name: 'read_page', speech: 'Read Page: Roadmap' }]);
  });

  it('given several calls in one response, should show them all', () => {
    const state = after([
      {
        type: 'event',
        event: {
          type: 'response.done',
          response: {
            output: [
              { type: 'function_call', call_id: 'c1', name: 'read_page', arguments: '{}' },
              { type: 'function_call', call_id: 'c2', name: 'list_pages', arguments: '{}' },
            ],
          },
        },
      },
    ]);

    expect(state.activeTools.map((t) => t.name)).toEqual(['read_page', 'list_pages']);
  });

  it('should clear when the model speaks again — the silence is over', () => {
    const state = after([
      toolCall('read_page', { title: 'Roadmap' }),
      {
        type: 'event',
        event: {
          type: 'response.output_audio_transcript.done',
          transcript: "It's in your Inbox.",
        },
      },
    ]);

    expect(state.activeTools).toEqual([]);
    expect(state.transcript).toHaveLength(1);
  });

  it('should KEEP showing the tool while the caller talks over it', () => {
    // `extractTranscript` returns the caller's transcripts too. Someone
    // speaking during a slow tool is the person waiting on it — clearing then
    // would drop the explanation for the silence exactly when it is needed.
    const state = after([
      toolCall('read_page', { title: 'Roadmap' }),
      {
        type: 'event',
        event: {
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'are you still there?',
        },
      },
    ]);

    expect(state.activeTools).toHaveLength(1);
    expect(state.transcript).toHaveLength(1);
  });

  it('should clear when a response finishes without calling anything', () => {
    const state = after([
      toolCall('read_page', { title: 'Roadmap' }),
      { type: 'event', event: { type: 'response.done', response: { output: [] } } },
    ]);

    expect(state.activeTools).toEqual([]);
  });

  it('given unparseable arguments, should still name the tool', () => {
    // Arguments are assembled from streamed deltas. A label is never worth
    // throwing over inside a reducer.
    const state = after([
      {
        type: 'event',
        event: {
          type: 'response.done',
          response: {
            output: [
              { type: 'function_call', call_id: 'c1', name: 'read_page', arguments: '{"title":' },
            ],
          },
        },
      },
    ]);

    expect(state.activeTools).toEqual([{ name: 'read_page', speech: 'Read Page' }]);
  });

  it('should not churn identity on an unrelated event', () => {
    // A re-render per housekeeping frame is a waveform that stutters.
    const base = after([{ type: 'connected' }]);
    const next = sessionReducer(base, {
      type: 'event',
      event: { type: 'rate_limits.updated' },
    });

    expect(next).toBe(base);
  });
});
