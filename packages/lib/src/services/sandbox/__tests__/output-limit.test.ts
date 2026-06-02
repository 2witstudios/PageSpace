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

  it('given a multi-byte boundary split, should cut on a char boundary and stay within the cap', () => {
    // '😀' is 4 UTF-8 bytes; a 2-byte cap splits it. A lenient decode would emit
    // U+FFFD (3 bytes) and BLOW the 2-byte cap; cutting on the boundary yields ''.
    const result = truncateToBytes({ text: '😀😀', maxBytes: 2 });
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(8);
    expect(result.text).toBe('');
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(2);
    expect(result.text).not.toContain('�');
  });

  it('given a mixed ASCII + multi-byte split, should keep the whole-char prefix within the cap', () => {
    // 'aé' = 'a'(1) + 'é'(2 bytes). maxBytes 2 splits 'é'; result must be 'a'.
    const result = truncateToBytes({ text: 'aé', maxBytes: 2 });
    expect(result.text).toBe('a');
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(2);
  });

  it('given any cap, the returned text never exceeds maxBytes (replacement-char inflation guard)', () => {
    const text = '😀aé😀b';
    for (let maxBytes = 0; maxBytes <= Buffer.byteLength(text, 'utf8'); maxBytes++) {
      const result = truncateToBytes({ text, maxBytes });
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('given empty/no text, should be safe', () => {
    expect(truncateToBytes({ maxBytes: 8 })).toEqual({
      text: '',
      truncated: false,
      originalBytes: 0,
    });
  });
});
