import { describe, it, expect } from 'vitest';
import { truncateToBytes, selectLineWindow } from '../output-limit';

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

  it('should never return text exceeding maxBytes, even when the replacement char would inflate it', () => {
    // The U+FFFD replacement char is 3 bytes; a naive cut+decode at maxBytes=2
    // would return a 3-byte string. The result must stay within the cap.
    for (const maxBytes of [1, 2, 3, 5, 7]) {
      const result = truncateToBytes({ text: '😀😀😀', maxBytes });
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(maxBytes);
      expect(result.truncated).toBe(true);
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

describe('selectLineWindow', () => {
  const five = 'a\nb\nc\nd\ne\n';

  it('given a window covering the whole file, should not report itself as windowed', () => {
    const result = selectLineWindow({ text: five, limit: 100 });
    expect(result).toEqual({
      text: five,
      firstLine: 1,
      lastLine: 5,
      totalLines: 5,
      windowed: false,
    });
  });

  it('given a trailing newline, should not count a phantom final empty line', () => {
    // 'a\nb\n'.split('\n') is ['a','b',''] — counting that as 3 lines would
    // make every newline-terminated file report one line more than it has.
    expect(selectLineWindow({ text: five, limit: 100 }).totalLines).toBe(5);
    expect(selectLineWindow({ text: 'a\nb', limit: 100 }).totalLines).toBe(2);
  });

  it('given a full read, should round-trip the file byte-for-byte', () => {
    expect(selectLineWindow({ text: five, limit: 100 }).text).toBe(five);
    expect(selectLineWindow({ text: 'a\nb', limit: 100 }).text).toBe('a\nb');
  });

  it('given a window that stops short, should not invent a trailing newline', () => {
    expect(selectLineWindow({ text: five, limit: 2 }).text).toBe('a\nb');
  });

  it('given an offset, should return a 1-based window', () => {
    const result = selectLineWindow({ text: five, offset: 2, limit: 2 });
    expect(result.text).toBe('b\nc');
    expect(result.firstLine).toBe(2);
    expect(result.lastLine).toBe(3);
    expect(result.windowed).toBe(true);
  });

  it('given an offset past the end, should return empty with the real total, not throw', () => {
    const result = selectLineWindow({ text: five, offset: 99, limit: 10 });
    expect(result.text).toBe('');
    expect(result.totalLines).toBe(5);
    expect(result.lastLine).toBeLessThan(result.firstLine);
  });

  it('given a zero or negative offset, should clamp to the start rather than wrap', () => {
    expect(selectLineWindow({ text: five, offset: 0, limit: 1 }).text).toBe('a');
    expect(selectLineWindow({ text: five, offset: -5, limit: 1 }).firstLine).toBe(1);
  });

  it('given empty text, should report one empty line and not be windowed', () => {
    const result = selectLineWindow({ text: '', limit: 10 });
    expect(result.text).toBe('');
    expect(result.windowed).toBe(false);
  });
});
