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

  it('given an ISO startedAt, should attach it as a createdAt Date', () => {
    const msg = synthesizeAssistantMessage('msg-1', [{ type: 'text' as const, text: 'hi' }], '2024-01-01T00:00:00.000Z');

    expect(msg.createdAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));
  });

  it('given no startedAt, should omit createdAt entirely (not set it to undefined)', () => {
    const msg = synthesizeAssistantMessage('msg-1', []);

    expect('createdAt' in msg).toBe(false);
  });

  it('given an unparseable startedAt, should omit createdAt rather than attach an Invalid Date', () => {
    const msg = synthesizeAssistantMessage('msg-1', [], 'not-a-date');

    expect('createdAt' in msg).toBe(false);
  });

  // Epic leaf 6.8 (D ixpwr76xepu2x9v4pxgksyhz): a live-open tab whose stream is
  // interrupted (crash reap, or an ordinary Stop) must badge it immediately, not
  // only after the next reload — mirrors createdAt's "set when known, omit
  // otherwise" convention.
  it('given status "interrupted", should attach it to the synthesized message', () => {
    const msg = synthesizeAssistantMessage('msg-1', [{ type: 'text' as const, text: 'hi' }], undefined, 'interrupted');
    expect(msg.status).toBe('interrupted');
  });

  it('given status "complete", should attach it to the synthesized message', () => {
    const msg = synthesizeAssistantMessage('msg-1', [], undefined, 'complete');
    expect(msg.status).toBe('complete');
  });

  it('given no status, should omit it entirely (not set it to undefined) — a live-streaming synthesis has no terminal status yet', () => {
    const msg = synthesizeAssistantMessage('msg-1', []);
    expect('status' in msg).toBe(false);
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
