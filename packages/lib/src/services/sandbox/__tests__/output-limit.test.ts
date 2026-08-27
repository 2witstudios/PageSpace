import { describe, it, expect } from 'vitest';
import { truncateToBytes, selectLineWindow, LINE_ELISION_MARKER } from '../output-limit';

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
      bytesCapped: false,
      lineElided: false,
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

describe('selectLineWindow — byte budget', () => {
  // The budget MUST be spent during selection. Applying it to the joined text
  // afterwards cut mid-window while lastLine still named the requested end, so
  // the caller resumed past the content and silently lost everything between.
  const wide = (count: number) =>
    Array.from({ length: count }, (_, i) => `line ${i + 1} ` + 'x'.repeat(90)).join('\n') + '\n';

  it('given a window that exceeds the byte budget, should report the line it ACTUALLY ended on', () => {
    const result = selectLineWindow({ text: wide(500), limit: 500, maxBytes: 1000 });
    const returnedLines = result.text.split('\n').length;
    expect(result.lastLine).toBe(returnedLines);
    expect(result.lastLine).toBeLessThan(500);
    expect(result.bytesCapped).toBe(true);
  });

  it('given a byte-capped window, should keep the text within the budget', () => {
    const result = selectLineWindow({ text: wide(500), limit: 500, maxBytes: 1000 });
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(1000);
  });

  it('given repeated paging at lastLine + 1, should reconstruct the file with no gaps', () => {
    const total = 400;
    const text = wide(total);
    const seen: string[] = [];
    let offset = 1;
    for (;;) {
      const w = selectLineWindow({ text, offset, limit: 500, maxBytes: 1000 });
      if (w.lastLine < w.firstLine) break;
      seen.push(...w.text.replace(/\n$/, '').split('\n'));
      if (w.lastLine >= w.totalLines) break;
      offset = w.lastLine + 1;
    }
    expect(seen.length).toBe(total);
    expect(seen[0]).toBe('line 1 ' + 'x'.repeat(90));
    expect(seen[total - 1]).toBe(`line ${total} ` + 'x'.repeat(90));
  });

  it('given one line larger than the whole budget, should still return it rather than stalling', () => {
    // Returning nothing would leave the caller with no way to make progress.
    const result = selectLineWindow({ text: 'x'.repeat(500) + '\nb\n', limit: 10, maxBytes: 100 });
    expect(result.lastLine).toBeGreaterThanOrEqual(1);
  });

  it('given a line over maxLineBytes, should clip it and mark it', () => {
    const result = selectLineWindow({ text: 'x'.repeat(500) + '\nb\n', limit: 10, maxLineBytes: 100 });
    expect(result.lineElided).toBe(true);
    expect(result.text).toContain(LINE_ELISION_MARKER);
  });

  it('given a line over maxLineBytes, the clipped line PLUS the elision marker should still fit maxLineBytes', () => {
    // The marker is ~22 bytes. Truncating the line content to maxLineBytes and
    // then appending the marker made the clipped line maxLineBytes + 22 long —
    // the marker has to come out of the same budget it is warning about.
    const result = selectLineWindow({ text: 'x'.repeat(500) + '\nb\n', limit: 10, maxLineBytes: 100 });
    const clippedLine = result.text.split('\n')[0];
    expect(Buffer.byteLength(clippedLine, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('given a full-file read whose content sits exactly at maxBytes, should never exceed it by restoring the trailing newline', () => {
    // A file ending in '\n' restores that terminator on a full read. Adding it
    // AFTER the loop's own budget accounting can push the result one byte past
    // the documented cap — the restoration has to pass the same check.
    const content = 'a'.repeat(10);
    const text = content + '\n'; // 11 bytes total, including the terminator
    const result = selectLineWindow({ text, limit: 10, maxBytes: 10 });
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(10);
  });

  it('given one enormous line, should keep the lines after it reachable', () => {
    // Without a per-line cap this line consumes the budget, and because paging
    // is by line there is then no offset that reaches line 2 at all.
    const result = selectLineWindow({
      text: 'A'.repeat(300 * 1024) + '\nline2\nline3\n',
      limit: 2000,
      maxBytes: 256 * 1024,
      maxLineBytes: 2000,
    });
    expect(result.lastLine).toBe(3);
    expect(result.text).toContain('line2');
    expect(result.text).toContain('line3');
  });
});
