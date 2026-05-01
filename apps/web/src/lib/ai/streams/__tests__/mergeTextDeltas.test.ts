import { describe, it, expect } from 'vitest';
import { mergeTextDeltas } from '../mergeTextDeltas';

describe('mergeTextDeltas', () => {
  it('given empty parts and a text part, should return a new array containing only the text part', () => {
    const textPart = { type: 'text' as const, text: 'hello' };
    expect(mergeTextDeltas([], textPart)).toEqual([textPart]);
  });
});
