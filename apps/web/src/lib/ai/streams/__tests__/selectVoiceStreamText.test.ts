import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import type { RenderedMessage } from '../selectRenderedMessages';
import { selectVoiceStreamText } from '../selectVoiceStreamText';

const textMsg = (id: string, role: UIMessage['role'], text: string): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text }] } as UIMessage);

const confirmed = (message: UIMessage): RenderedMessage => ({ message, mode: 'confirmed' });
const streaming = (message: UIMessage): RenderedMessage => ({ message, mode: 'streaming' });

describe('selectVoiceStreamText', () => {
  it('given the last rendered row is streaming, should return its joined text', () => {
    const rendered = [confirmed(textMsg('u1', 'user', 'hi')), streaming(textMsg('a1', 'assistant', 'Hello there'))];
    expect(selectVoiceStreamText(rendered)).toBe('Hello there');
  });

  it('given nothing is streaming, should return null', () => {
    const rendered = [confirmed(textMsg('u1', 'user', 'hi')), confirmed(textMsg('a1', 'assistant', 'done'))];
    expect(selectVoiceStreamText(rendered)).toBeNull();
  });

  it('given an empty rendered list, should return null', () => {
    expect(selectVoiceStreamText([])).toBeNull();
  });

  it('given multiple text parts on the streaming row, should join them', () => {
    const msg = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'foo' }, { type: 'text', text: 'bar' }] } as UIMessage;
    expect(selectVoiceStreamText([streaming(msg)])).toBe('foobar');
  });

  it('given non-text parts on the streaming row, should ignore them', () => {
    const msg = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'foo' }, { type: 'tool-ask_user', toolCallId: 'tc1' }],
    } as UIMessage;
    expect(selectVoiceStreamText([streaming(msg)])).toBe('foo');
  });
});
