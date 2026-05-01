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
});
