import { describe, it, expect } from 'vitest';
import { chunkToPart } from '../chunkToPart';

describe('chunkToPart', () => {
  it('given a text-delta chunk, should return a text part with the same text', () => {
    expect(
      chunkToPart({ type: 'text-delta', id: 't1', text: 'hello' }),
    ).toEqual({ type: 'text', text: 'hello' });
  });
});
