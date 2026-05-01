import { describe, it, expect } from 'vitest';
import { mergeTextDeltas } from '../mergeTextDeltas';

describe('mergeTextDeltas', () => {
  it('given empty parts and a text part, should return a new array containing only the text part', () => {
    const textPart = { type: 'text' as const, text: 'hello' };
    expect(mergeTextDeltas([], textPart)).toEqual([textPart]);
  });

  it('given parts ending in a text part, should concat the new text into that last part', () => {
    const initial = [{ type: 'text' as const, text: 'hel' }];
    const next = { type: 'text' as const, text: 'lo' };
    expect(mergeTextDeltas(initial, next)).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('given parts ending in a tool part, should append the text part as a new entry rather than concat', () => {
    const initial = [
      { type: 'text' as const, text: 'before' },
      {
        type: 'tool-list_pages' as const,
        toolCallId: 'tc1',
        state: 'output-available' as const,
        input: { driveId: 'd1' },
        output: { pages: [] },
      },
    ];
    const next = { type: 'text' as const, text: 'after' };
    expect(mergeTextDeltas(initial, next)).toEqual([
      ...initial,
      { type: 'text', text: 'after' },
    ]);
  });

  it('given a non-empty initial, should not mutate the input array', () => {
    const initial = [{ type: 'text' as const, text: 'hel' }];
    const snapshot = JSON.parse(JSON.stringify(initial));
    mergeTextDeltas(initial, { type: 'text', text: 'lo' });
    expect(initial).toEqual(snapshot);
  });
});
