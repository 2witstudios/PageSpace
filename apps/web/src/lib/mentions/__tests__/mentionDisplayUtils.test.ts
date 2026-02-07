import { describe, it, expect } from 'vitest';
import {
  markdownToDisplay,
  displayToMarkdown,
  findEditRegion,
  updateMentionPositions,
  TrackedMention,
} from '../mentionDisplayUtils';

describe('markdownToDisplay', () => {
  it('given plain text with no mentions, should return text unchanged with empty mentions', () => {
    const result = markdownToDisplay('hello world');
    expect(result).toEqual({ displayText: 'hello world', mentions: [] });
  });

  it('given empty string, should return empty display text', () => {
    const result = markdownToDisplay('');
    expect(result).toEqual({ displayText: '', mentions: [] });
  });

  it('given a single page mention, should extract label and track position', () => {
    const result = markdownToDisplay('@[My Doc](p1:page)');
    expect(result.displayText).toBe('@My Doc');
    expect(result.mentions).toEqual([
      { start: 0, end: 7, label: 'My Doc', id: 'p1', type: 'page' },
    ]);
  });

  it('given a single user mention, should extract label and track position', () => {
    const result = markdownToDisplay('@[Alice](u1:user)');
    expect(result.displayText).toBe('@Alice');
    expect(result.mentions).toEqual([
      { start: 0, end: 6, label: 'Alice', id: 'u1', type: 'user' },
    ]);
  });

  it('given mixed text with mentions, should track all positions correctly', () => {
    const result = markdownToDisplay(
      '@[Alice](u1:user) hi @[Doc](p1:page)'
    );
    expect(result.displayText).toBe('@Alice hi @Doc');
    expect(result.mentions).toHaveLength(2);
    expect(result.mentions[0]).toEqual({
      start: 0,
      end: 6,
      label: 'Alice',
      id: 'u1',
      type: 'user',
    });
    expect(result.mentions[1]).toEqual({
      start: 10,
      end: 14,
      label: 'Doc',
      id: 'p1',
      type: 'page',
    });
  });

  it('given text before and after mention, should preserve surrounding text', () => {
    const result = markdownToDisplay('Hello @[Alice](u1:user) bye');
    expect(result.displayText).toBe('Hello @Alice bye');
    expect(result.mentions).toEqual([
      { start: 6, end: 12, label: 'Alice', id: 'u1', type: 'user' },
    ]);
  });

  it('given adjacent mentions with no space, should track both positions', () => {
    const result = markdownToDisplay('@[A](a:user)@[B](b:page)');
    expect(result.displayText).toBe('@A@B');
    expect(result.mentions).toEqual([
      { start: 0, end: 2, label: 'A', id: 'a', type: 'user' },
      { start: 2, end: 4, label: 'B', id: 'b', type: 'page' },
    ]);
  });
});

describe('displayToMarkdown', () => {
  it('given text with no mentions, should return text unchanged', () => {
    expect(displayToMarkdown('hello world', [])).toBe('hello world');
  });

  it('given display text with tracked mentions, should reconstruct markdown', () => {
    const mentions: TrackedMention[] = [
      { start: 0, end: 6, label: 'Alice', id: 'u1', type: 'user' },
    ];
    expect(displayToMarkdown('@Alice', mentions)).toBe(
      '@[Alice](u1:user)'
    );
  });

  it('given multiple mentions, should reconstruct all in correct positions', () => {
    const mentions: TrackedMention[] = [
      { start: 0, end: 6, label: 'Alice', id: 'u1', type: 'user' },
      { start: 10, end: 14, label: 'Doc', id: 'p1', type: 'page' },
    ];
    expect(displayToMarkdown('@Alice hi @Doc', mentions)).toBe(
      '@[Alice](u1:user) hi @[Doc](p1:page)'
    );
  });

  it('given round-trip conversion, should be lossless', () => {
    const original = 'Hello @[Alice](u1:user), see @[My Doc](p1:page) please';
    const { displayText, mentions } = markdownToDisplay(original);
    const reconstructed = displayToMarkdown(displayText, mentions);
    expect(reconstructed).toBe(original);
  });
});

describe('findEditRegion', () => {
  it('given identical strings, should return start=end', () => {
    const result = findEditRegion('abc', 'abc');
    expect(result).toEqual({ start: 3, oldEnd: 3, newEnd: 3 });
  });

  it('given insertion at end, should detect appended text', () => {
    const result = findEditRegion('abc', 'abcd');
    expect(result).toEqual({ start: 3, oldEnd: 3, newEnd: 4 });
  });

  it('given deletion at end, should detect removed text', () => {
    const result = findEditRegion('abcd', 'abc');
    expect(result).toEqual({ start: 3, oldEnd: 4, newEnd: 3 });
  });

  it('given insertion in middle, should detect inserted region', () => {
    const result = findEditRegion('ac', 'abc');
    expect(result).toEqual({ start: 1, oldEnd: 1, newEnd: 2 });
  });

  it('given replacement in middle, should detect replaced region', () => {
    const result = findEditRegion('abc', 'axc');
    expect(result).toEqual({ start: 1, oldEnd: 2, newEnd: 2 });
  });

  it('given complete replacement, should return full range', () => {
    const result = findEditRegion('abc', 'xyz');
    expect(result).toEqual({ start: 0, oldEnd: 3, newEnd: 3 });
  });
});

describe('updateMentionPositions', () => {
  const baseMentions: TrackedMention[] = [
    { start: 0, end: 6, label: 'Alice', id: 'u1', type: 'user' },
    { start: 10, end: 14, label: 'Doc', id: 'p1', type: 'page' },
  ];

  it('given no change, should return mentions unchanged', () => {
    const result = updateMentionPositions(baseMentions, '@Alice hi @Doc', '@Alice hi @Doc');
    expect(result).toEqual(baseMentions);
  });

  it('given text appended after all mentions, should keep all mentions', () => {
    const result = updateMentionPositions(
      baseMentions,
      '@Alice hi @Doc',
      '@Alice hi @Doc more text'
    );
    expect(result).toEqual(baseMentions);
  });

  it('given text inserted between mentions, should shift later mentions', () => {
    // Insert " extra" between mentions: "@Alice hi extra @Doc"
    const result = updateMentionPositions(
      baseMentions,
      '@Alice hi @Doc',
      '@Alice hi extra @Doc'
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(baseMentions[0]); // First mention unchanged
    expect(result[1]).toEqual({
      start: 16,
      end: 20,
      label: 'Doc',
      id: 'p1',
      type: 'page',
    });
  });

  it('given text deleted between mentions, should shift later mentions back', () => {
    // Delete " hi " → "@Alice@Doc"
    const result = updateMentionPositions(
      baseMentions,
      '@Alice hi @Doc',
      '@Alice @Doc'
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(baseMentions[0]);
    expect(result[1]).toEqual({
      start: 7,
      end: 11,
      label: 'Doc',
      id: 'p1',
      type: 'page',
    });
  });

  it('given edit overlapping a mention, should remove that mention', () => {
    // Modify "@Alice" → "@Ali" — overlaps first mention
    const result = updateMentionPositions(
      baseMentions,
      '@Alice hi @Doc',
      '@Ali hi @Doc'
    );
    // First mention is removed (overlapped by edit), second is shifted
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Doc');
    expect(result[0].start).toBe(8);
    expect(result[0].end).toBe(12);
  });

  it('given edit within a mention, should remove that mention', () => {
    // Type inside "@Alice" → "@Alxice"
    const result = updateMentionPositions(
      baseMentions,
      '@Alice hi @Doc',
      '@Alxice hi @Doc'
    );
    // First mention removed, second shifted
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Doc');
  });

  it('given empty mentions array, should return empty', () => {
    const result = updateMentionPositions([], 'abc', 'abcd');
    expect(result).toEqual([]);
  });
});
