import { describe, it, expect } from 'vitest';
import { truncateToBytes } from '../output-limit';

describe('truncateToBytes', () => {
  it('given output within the cap, should return it unchanged and untruncated', () => {
    const result = truncateToBytes({ text: 'hello', maxBytes: 32 });
    expect(result).toEqual({ text: 'hello', truncated: false, originalBytes: 5 });
  });

  it('given output exactly at the cap, should not truncate', () => {
    const result = truncateToBytes({ text: 'abcd', maxBytes: 4 });
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('abcd');
  });

  it('given output over the cap, should truncate to the byte limit and flag it', () => {
    const result = truncateToBytes({ text: 'abcdefghij', maxBytes: 4 });
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('abcd');
    expect(result.originalBytes).toBe(10);
  });

  it('given a multi-byte boundary split, should not throw and should report original bytes', () => {
    // '😀' is 4 UTF-8 bytes; a 2-byte cap splits it.
    const result = truncateToBytes({ text: '😀😀', maxBytes: 2 });
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(8);
    expect(typeof result.text).toBe('string');
  });

  it('given empty/no text, should be safe', () => {
    expect(truncateToBytes({ maxBytes: 8 })).toEqual({
      text: '',
      truncated: false,
      originalBytes: 0,
    });
  });
});
