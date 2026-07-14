import { describe, it, expect } from 'vitest';
import { seedEmpty } from '../seedEmpty';

describe('seedEmpty', () => {
  it('given no arguments, should produce an empty cache entry at generation 0', () => {
    expect(seedEmpty()).toEqual({ messages: [], optimisticSends: [], loadGeneration: 0 });
  });

  it('given two calls, should produce referentially independent entries', () => {
    const a = seedEmpty();
    const b = seedEmpty();
    expect(a).not.toBe(b);
    expect(a.messages).not.toBe(b.messages);
  });
});
