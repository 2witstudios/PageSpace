import { describe, expect, it } from 'vitest';
import {
  buildFunctionOutput,
  extractFunctionCalls,
  extractTranscript,
  parseEvent,
  RESPONSE_CREATE,
} from '../events';

const call = (over: Record<string, unknown> = {}) => ({
  type: 'function_call',
  name: 'read_page',
  call_id: 'call_1',
  arguments: '{"pageId":"p1"}',
  ...over,
});

const responseDone = (output: unknown[]) => ({
  type: 'response.done',
  response: { output },
});

describe('extractFunctionCalls', () => {
  it('given a completed response with a call, should extract it', () => {
    expect(extractFunctionCalls(responseDone([call()]))).toEqual([
      { callId: 'call_1', name: 'read_page', argumentsJson: '{"pageId":"p1"}' },
    ]);
  });

  it('given two calls in one turn, should extract both with id, name and arguments', () => {
    expect(
      extractFunctionCalls(
        responseDone([
          call(),
          call({
            call_id: 'call_2',
            name: 'list_pages',
            arguments: undefined,
          }),
        ]),
      ),
    ).toEqual([
      { callId: 'call_1', name: 'read_page', argumentsJson: '{"pageId":"p1"}' },
      // Absent arguments = a no-argument tool, not a malformed call.
      { callId: 'call_2', name: 'list_pages', argumentsJson: '{}' },
    ]);
  });

  it('given a tool with empty-string arguments, should default to an empty object', () => {
    const [only] = extractFunctionCalls(responseDone([call({ arguments: '' })]));
    expect(only.argumentsJson).toBe('{}');
  });

  it('given a tool with non-string arguments, should default to an empty object', () => {
    const [only] = extractFunctionCalls(responseDone([call({ arguments: 7 })]));
    expect(only.argumentsJson).toBe('{}');
  });

  it('given non-call output items, should ignore them', () => {
    expect(
      extractFunctionCalls(responseDone([{ type: 'message' }, call()])),
    ).toHaveLength(1);
  });

  it('given a malformed item, should skip it rather than throw', () => {
    expect(extractFunctionCalls(responseDone([null, 'nope']))).toEqual([]);
  });

  it('given a call missing its id, should skip it', () => {
    expect(
      extractFunctionCalls(responseDone([call({ call_id: undefined })])),
    ).toEqual([]);
  });

  it('given a call missing its name, should skip it', () => {
    expect(
      extractFunctionCalls(responseDone([call({ name: undefined })])),
    ).toEqual([]);
  });

  it('given a different event type, should return nothing', () => {
    expect(extractFunctionCalls({ type: 'response.created' })).toEqual([]);
  });

  it('given output that is not an array, should return nothing', () => {
    expect(
      extractFunctionCalls({ type: 'response.done', response: { output: 'x' } }),
    ).toEqual([]);
  });

  it('given no response object, should return nothing', () => {
    expect(extractFunctionCalls({ type: 'response.done' })).toEqual([]);
  });

  it('given a non-object event, should return nothing', () => {
    expect(extractFunctionCalls(null)).toEqual([]);
    expect(extractFunctionCalls('response.done')).toEqual([]);
  });
});

describe('extractTranscript', () => {
  it('given a completed input transcription, should attribute it to the user', () => {
    expect(
      extractTranscript({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'read my notes',
      }),
    ).toEqual({ role: 'user', text: 'read my notes' });
  });

  it('given the current assistant transcript event, should attribute it to the assistant', () => {
    expect(
      extractTranscript({
        type: 'response.output_audio_transcript.done',
        transcript: 'Here you go.',
      }),
    ).toEqual({ role: 'assistant', text: 'Here you go.' });
  });

  it('given the older assistant transcript name, should extract it identically', () => {
    const current = extractTranscript({
      type: 'response.output_audio_transcript.done',
      transcript: 'Here you go.',
    });
    const older = extractTranscript({
      type: 'response.audio_transcript.done',
      transcript: 'Here you go.',
    });
    expect(older).toEqual(current);
    expect(older).toEqual({ role: 'assistant', text: 'Here you go.' });
  });

  it('given an empty user transcript, should return nothing', () => {
    expect(
      extractTranscript({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: '',
      }),
    ).toBeUndefined();
  });

  it('given an empty assistant transcript, should return nothing', () => {
    expect(
      extractTranscript({
        type: 'response.audio_transcript.done',
        transcript: '',
      }),
    ).toBeUndefined();
  });

  it('given an unrelated event, should return nothing', () => {
    expect(extractTranscript({ type: 'response.created' })).toBeUndefined();
  });

  it('given an event with no type, should return nothing', () => {
    expect(extractTranscript({})).toBeUndefined();
  });

  it('given an event with a non-string type, should return nothing', () => {
    expect(extractTranscript({ type: 7 })).toBeUndefined();
  });

  it('given a non-object, should return nothing', () => {
    expect(extractTranscript(undefined)).toBeUndefined();
    expect(extractTranscript(null)).toBeUndefined();
  });
});

describe('buildFunctionOutput', () => {
  it('given a result, should address it to the originating call', () => {
    expect(buildFunctionOutput('call_1', 'Done.')).toEqual({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Done.',
      },
    });
  });
});

describe('RESPONSE_CREATE', () => {
  it('given tool output was sent, should prompt the model to speak', () => {
    expect(RESPONSE_CREATE).toEqual({ type: 'response.create' });
  });
});

describe('parseEvent', () => {
  it('given a JSON frame, should parse it', () => {
    expect(parseEvent('{"type":"x"}')).toEqual({ type: 'x' });
  });

  it('given a malformed frame, should return undefined rather than throw', () => {
    expect(() => parseEvent('{oops')).not.toThrow();
    expect(parseEvent('{oops')).toBeUndefined();
  });

  it('given binary data, should return undefined', () => {
    expect(parseEvent(new ArrayBuffer(2))).toBeUndefined();
  });

  it('given an already-decoded frame, should return undefined rather than pass it through', () => {
    // JSON.parse coerces these to parseable strings ('42', 'null'), so only the
    // non-string guard keeps them out — a frame the channel never delivers as a
    // string is not an event.
    expect(parseEvent(42)).toBeUndefined();
    expect(parseEvent(null)).toBeUndefined();
  });
});
