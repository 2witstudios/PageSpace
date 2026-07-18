import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import type { RenderedMessage } from '../selectRenderedMessages';
import { selectPostBaselineAssistantMessage } from '../selectPostBaselineAssistantMessage';

const textMsg = (id: string, role: UIMessage['role'], text: string): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text }] } as UIMessage);

const confirmed = (message: UIMessage): RenderedMessage => ({ message, mode: 'confirmed' });
const streaming = (message: UIMessage): RenderedMessage => ({ message, mode: 'streaming' });

describe('selectPostBaselineAssistantMessage', () => {
  it('given a settled assistant message newer than the baseline, should publish it', () => {
    const rendered = [confirmed(textMsg('u1', 'user', 'hi')), confirmed(textMsg('a1', 'assistant', 'hello'))];
    expect(selectPostBaselineAssistantMessage(rendered, null)).toEqual({ id: 'a1', text: 'hello' });
  });

  it('given the last assistant message IS the baseline, should publish nothing (already spoken/pre-existing)', () => {
    const rendered = [confirmed(textMsg('a1', 'assistant', 'hello'))];
    expect(selectPostBaselineAssistantMessage(rendered, 'a1')).toBeNull();
  });

  it('given a stream is still in flight, should publish nothing (only settled rows count)', () => {
    const rendered = [confirmed(textMsg('a1', 'assistant', 'old')), streaming(textMsg('a2', 'assistant', 'partial'))];
    expect(selectPostBaselineAssistantMessage(rendered, 'a1')).toBeNull();
  });

  it('given the newest settled assistant message has empty text, should publish nothing', () => {
    const rendered = [confirmed(textMsg('a1', 'assistant', ''))];
    expect(selectPostBaselineAssistantMessage(rendered, null)).toBeNull();
  });

  it('given no assistant message exists, should publish nothing', () => {
    expect(selectPostBaselineAssistantMessage([confirmed(textMsg('u1', 'user', 'hi'))], null)).toBeNull();
  });
});
