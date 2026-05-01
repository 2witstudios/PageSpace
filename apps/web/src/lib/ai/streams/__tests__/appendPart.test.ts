import { describe, it, expect } from 'vitest';
import { appendPart } from '../appendPart';

describe('appendPart', () => {
  it('given a text part and parts ending in text, should concat into the last text part', () => {
    const initial = [{ type: 'text' as const, text: 'hel' }];
    const next = { type: 'text' as const, text: 'lo' };
    expect(appendPart(initial, next)).toEqual([{ type: 'text', text: 'hello' }]);
  });
});
