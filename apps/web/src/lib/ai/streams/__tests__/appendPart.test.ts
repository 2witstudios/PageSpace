import { describe, it, expect } from 'vitest';
import { appendPart } from '../appendPart';

describe('appendPart', () => {
  it('given a text part and parts ending in text, should concat into the last text part', () => {
    const initial = [{ type: 'text' as const, text: 'hel' }];
    const next = { type: 'text' as const, text: 'lo' };
    expect(appendPart(initial, next)).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('given a tool part with a toolCallId not yet in parts, should append it', () => {
    const initial = [{ type: 'text' as const, text: 'thinking' }];
    const tool = {
      type: 'tool-list_pages' as const,
      toolCallId: 'tc1',
      state: 'input-available' as const,
      input: { driveId: 'd1' },
    };
    expect(appendPart(initial, tool)).toEqual([...initial, tool]);
  });
});
