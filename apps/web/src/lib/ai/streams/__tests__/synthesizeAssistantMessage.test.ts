import { describe, it, expect } from 'vitest';
import { synthesizeAssistantMessage } from '../synthesizeAssistantMessage';

describe('synthesizeAssistantMessage', () => {
  it('given a messageId and text, should produce an assistant UIMessage with one text part holding that text', () => {
    const msg = synthesizeAssistantMessage('msg-1', 'Hello world');

    expect(msg).toEqual({
      id: 'msg-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Hello world' }],
    });
  });

  it('given empty text, should still produce a valid message (the renderer suppresses empty parts)', () => {
    const msg = synthesizeAssistantMessage('msg-1', '');

    expect(msg.id).toBe('msg-1');
    expect(msg.role).toBe('assistant');
    expect(msg.parts).toEqual([{ type: 'text', text: '' }]);
  });

  it('given the same input twice, should produce structurally equal messages (referentially independent)', () => {
    const a = synthesizeAssistantMessage('msg-1', 'hi');
    const b = synthesizeAssistantMessage('msg-1', 'hi');

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.parts).not.toBe(b.parts);
  });
});
