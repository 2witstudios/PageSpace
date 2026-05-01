import { describe, it, expect } from 'vitest';
import { synthesizeAssistantMessage } from '../synthesizeAssistantMessage';

describe('synthesizeAssistantMessage', () => {
  it('given a messageId and a parts array, should produce an assistant UIMessage carrying those parts', () => {
    const parts = [{ type: 'text' as const, text: 'Hello world' }];
    const msg = synthesizeAssistantMessage('msg-1', parts);

    expect(msg).toEqual({
      id: 'msg-1',
      role: 'assistant',
      parts,
    });
  });

  it('given an empty parts array, should still produce a valid message with id, role, and empty parts', () => {
    const msg = synthesizeAssistantMessage('msg-1', []);

    expect(msg.id).toBe('msg-1');
    expect(msg.role).toBe('assistant');
    expect(msg.parts).toEqual([]);
  });

  it('given parts with a text part and a tool part, should preserve their order in the synthesized message', () => {
    const parts = [
      { type: 'text' as const, text: 'thinking' },
      {
        type: 'tool-list_pages' as const,
        toolCallId: 'tc1',
        toolName: 'list_pages',
        state: 'output-available' as const,
        input: { driveId: 'd1' },
        output: { pages: [] },
      },
    ];
    const msg = synthesizeAssistantMessage('msg-1', parts);

    expect(msg.parts.map((p) => p.type)).toEqual(['text', 'tool-list_pages']);
  });

  it('given the same input twice, should produce structurally equal messages but referentially independent parts arrays', () => {
    const parts = [{ type: 'text' as const, text: 'hi' }];
    const a = synthesizeAssistantMessage('msg-1', parts);
    const b = synthesizeAssistantMessage('msg-1', parts);

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.parts).not.toBe(b.parts);
    expect(a.parts).not.toBe(parts);
  });
});
