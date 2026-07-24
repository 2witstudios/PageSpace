import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { getTextSinceLastUserTurn, hasTextSinceLastUserTurn } from '../getTextSinceLastUserTurn';

const msg = (id: string, role: UIMessage['role'], parts: UIMessage['parts']): UIMessage => ({
  id,
  role,
  parts,
});

const text = (t: string) => ({ type: 'text' as const, text: t });

describe('getTextSinceLastUserTurn', () => {
  it('given no user message at all, returns empty string', () => {
    const messages = [msg('a1', 'assistant', [text('hello')])];
    expect(getTextSinceLastUserTurn(messages)).toBe('');
  });

  it('given a single assistant reply, returns its text', () => {
    const messages = [msg('u1', 'user', [text('hi')]), msg('a1', 'assistant', [text('hello there')])];
    expect(getTextSinceLastUserTurn(messages)).toBe('hello there');
  });

  it('given multiple consecutive assistant messages, joins their text in order', () => {
    const messages = [
      msg('u1', 'user', [text('go')]),
      msg('a1', 'assistant', [text('step one')]),
      msg('a2', 'assistant', [text('step two')]),
    ];
    expect(getTextSinceLastUserTurn(messages)).toBe('step one\n\nstep two');
  });

  it('skips tool-call parts and only reads text parts within a message', () => {
    const messages = [
      msg('u1', 'user', [text('run it')]),
      msg('a1', 'assistant', [
        { type: 'tool-run', toolCallId: 't1', state: 'output-available' } as unknown as UIMessage['parts'][number],
        text('done running'),
      ]),
    ];
    expect(getTextSinceLastUserTurn(messages)).toBe('done running');
  });

  it('given a trailing tool-only message with no text, drops it from the joined output', () => {
    const messages = [
      msg('u1', 'user', [text('go')]),
      msg('a1', 'assistant', [text('here is the answer')]),
      msg('a2', 'assistant', [
        { type: 'tool-run', toolCallId: 't2', state: 'output-available' } as unknown as UIMessage['parts'][number],
      ]),
    ];
    expect(getTextSinceLastUserTurn(messages)).toBe('here is the answer');
  });

  it('given the last user message has no reply yet, returns empty string', () => {
    const messages = [msg('a1', 'assistant', [text('old reply')]), msg('u1', 'user', [text('new question')])];
    expect(getTextSinceLastUserTurn(messages)).toBe('');
  });

  it('given an empty array, returns empty string', () => {
    expect(getTextSinceLastUserTurn([])).toBe('');
  });
});

describe('hasTextSinceLastUserTurn', () => {
  it('given no user message at all, returns false', () => {
    expect(hasTextSinceLastUserTurn([msg('a1', 'assistant', [text('hello')])])).toBe(false);
  });

  it('given a single assistant reply with text, returns true', () => {
    const messages = [msg('u1', 'user', [text('hi')]), msg('a1', 'assistant', [text('hello there')])];
    expect(hasTextSinceLastUserTurn(messages)).toBe(true);
  });

  it('given only tool-call parts and no text, returns false', () => {
    const messages = [
      msg('u1', 'user', [text('run it')]),
      msg('a1', 'assistant', [
        { type: 'tool-run', toolCallId: 't1', state: 'output-available' } as unknown as UIMessage['parts'][number],
      ]),
    ];
    expect(hasTextSinceLastUserTurn(messages)).toBe(false);
  });

  it('given a text part that is only whitespace, returns false', () => {
    const messages = [msg('u1', 'user', [text('hi')]), msg('a1', 'assistant', [text('   ')])];
    expect(hasTextSinceLastUserTurn(messages)).toBe(false);
  });

  it('given the last user message has no reply yet, returns false', () => {
    const messages = [msg('a1', 'assistant', [text('old reply')]), msg('u1', 'user', [text('new question')])];
    expect(hasTextSinceLastUserTurn(messages)).toBe(false);
  });
});
