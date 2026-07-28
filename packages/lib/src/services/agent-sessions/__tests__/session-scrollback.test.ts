import { describe, it, expect } from 'vitest';
import {
  MAX_SCROLLBACK_TAIL_BYTES,
  scrollbackLines,
  capTailBytes,
  tailOfLines,
} from '../session-scrollback';

describe('scrollbackLines', () => {
  it('given an empty ring, should return no lines', () => {
    expect(scrollbackLines([])).toEqual([]);
  });

  it('given chunks that split a line, should join them before splitting', () => {
    expect(scrollbackLines(['he', 'llo\r\nworld\r\n'])).toEqual(['hello', 'world']);
  });

  it('given CRLF line endings, should normalize them to LF', () => {
    expect(scrollbackLines(['one\r\ntwo\r\n'])).toEqual(['one', 'two']);
  });

  it('given bare CR line endings, should normalize them to LF', () => {
    expect(scrollbackLines(['one\rtwo\r'])).toEqual(['one', 'two']);
  });

  it('given a ring ending WITHOUT a trailing newline, should keep the final partial line', () => {
    expect(scrollbackLines(['one\r\ntwo'])).toEqual(['one', 'two']);
  });
});

describe('tailOfLines', () => {
  it('given limit 0, should return empty regardless of the ring', () => {
    expect(tailOfLines(['a', 'b', 'c'], 0)).toBe('');
  });

  it('given a negative limit, should return empty', () => {
    expect(tailOfLines(['a', 'b'], -1)).toBe('');
  });

  it('given limit 1, should return only the last line', () => {
    expect(tailOfLines(['a', 'b', 'c'], 1)).toBe('c');
  });

  it('given more lines than the limit, should keep the tail', () => {
    expect(tailOfLines(['1', '2', '3', '4'], 2)).toBe('3\n4');
  });

  it('given a limit larger than the number of lines, should return them all', () => {
    expect(tailOfLines(['a', 'b'], 100)).toBe('a\nb');
  });

  it('given an empty ring, should return empty', () => {
    expect(tailOfLines([], 5)).toBe('');
  });

  it('given a tail larger than the byte cap, should drop whole leading lines until it fits', () => {
    const lines = Array.from({ length: 8 }, () => 'x'.repeat(4000));
    const tail = tailOfLines(lines, 500);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(MAX_SCROLLBACK_TAIL_BYTES);
    expect(tail.split('\n').every((line) => line.length === 4000)).toBe(true);
  });

  it('given ONE newline-free line larger than the byte cap, should keep only its tail bytes with a marker', () => {
    const tail = tailOfLines(['x'.repeat(40_000)], 5);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(MAX_SCROLLBACK_TAIL_BYTES);
    expect(tail.endsWith('x')).toBe(true);
    expect(tail.startsWith('…')).toBe(true);
  });

  it('given a multi-byte character straddling the cut point, should not split it mid-character', () => {
    // A 3-byte UTF-8 char ('€') repeated so the cut lands mid-character unless
    // the boundary walk steps forward off it.
    const line = '€'.repeat(20_000);
    const tail = tailOfLines([line], 1);
    // Re-encoding must round-trip without producing the U+FFFD replacement
    // character, which is what a mid-sequence byte slice would decode to.
    expect(tail.includes('�')).toBe(false);
  });

  it('given a tail exactly at the byte cap boundary, should return it unmarked', () => {
    const line = 'x'.repeat(MAX_SCROLLBACK_TAIL_BYTES);
    const tail = tailOfLines([line], 1);
    expect(tail).toBe(line);
    expect(tail.startsWith('…')).toBe(false);
  });
});

describe('capTailBytes', () => {
  it('given an empty ring, should return empty', () => {
    expect(capTailBytes([])).toBe('');
  });

  it('given lines within the cap, should return them all — no limit applied here, only the byte cap', () => {
    expect(capTailBytes(['a', 'b', 'c'])).toBe('a\nb\nc');
  });

  it('given a ring over the byte cap, should drop whole leading lines until it fits', () => {
    const lines = Array.from({ length: 8 }, () => 'x'.repeat(4000));
    const tail = capTailBytes(lines);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(MAX_SCROLLBACK_TAIL_BYTES);
    expect(tail.split('\n').every((line) => line.length === 4000)).toBe(true);
  });

  it('given ONE newline-free line larger than the byte cap, should cut mid-line with a marker', () => {
    const tail = capTailBytes(['x'.repeat(40_000)]);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(MAX_SCROLLBACK_TAIL_BYTES);
    expect(tail.startsWith('…')).toBe(true);
  });
});
