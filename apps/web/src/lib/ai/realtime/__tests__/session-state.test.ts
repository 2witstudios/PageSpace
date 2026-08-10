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
      tools: [],
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

  it('given a failure after a tool ran, should keep the tool record too', () => {
    const state = after([
      { type: 'tool', name: 'read_page', speech: 'Notes: hi' },
      { type: 'failed', message: 'dropped' },
    ]);
    expect(state.tools).toHaveLength(1);
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

describe('tool activity', () => {
  it('given tools ran, should record what they were and what they said, in order', () => {
    const state = after([
      { type: 'tool', name: 'read_page', speech: 'Notes: hi' },
      { type: 'tool', name: 'list_pages', speech: 'You have 1 page' },
    ]);
    expect(state.tools).toEqual([
      { name: 'read_page', speech: 'Notes: hi' },
      { name: 'list_pages', speech: 'You have 1 page' },
    ]);
  });
});
