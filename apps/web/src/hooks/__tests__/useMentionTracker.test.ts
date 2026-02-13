import { describe, it, expect } from 'vitest';
import {
  markdownToDisplay,
  displayToMarkdown,
  TrackedMention,
} from '../useMentionTracker';

describe('markdownToDisplay', () => {
  it('given plain text with no mentions, should return text unchanged', () => {
    const result = markdownToDisplay('hello world');

    expect(result.displayText).toBe('hello world');
    expect(result.mentions).toEqual([]);
  });

  it('given empty string, should return empty string', () => {
    const result = markdownToDisplay('');

    expect(result.displayText).toBe('');
    expect(result.mentions).toEqual([]);
  });

  it('given a single page mention, should extract display text and position', () => {
    const result = markdownToDisplay('@[My Page](abc123:page)');

    expect(result.displayText).toBe('@My Page');
    expect(result.mentions).toEqual([
      { start: 0, end: 8, label: 'My Page', id: 'abc123', type: 'page' },
    ]);
  });

  it('given a single user mention, should extract display text and position', () => {
    const result = markdownToDisplay('@[Alice](user1:user)');

    expect(result.displayText).toBe('@Alice');
    expect(result.mentions).toEqual([
      { start: 0, end: 6, label: 'Alice', id: 'user1', type: 'user' },
    ]);
  });

  it('given mention surrounded by text, should calculate correct positions', () => {
    const result = markdownToDisplay('Hello @[Alice](user1:user) world');

    expect(result.displayText).toBe('Hello @Alice world');
    expect(result.mentions).toEqual([
      { start: 6, end: 12, label: 'Alice', id: 'user1', type: 'user' },
    ]);
  });

  it('given multiple mentions, should track all positions correctly', () => {
    const result = markdownToDisplay(
      'Hey @[Alice](a:user) and @[Doc](d:page) bye'
    );

    expect(result.displayText).toBe('Hey @Alice and @Doc bye');
    expect(result.mentions).toHaveLength(2);
    expect(result.mentions[0]).toEqual({
      start: 4,
      end: 10,
      label: 'Alice',
      id: 'a',
      type: 'user',
    });
    expect(result.mentions[1]).toEqual({
      start: 15,
      end: 19,
      label: 'Doc',
      id: 'd',
      type: 'page',
    });
  });

  it('given adjacent mentions, should calculate positions correctly', () => {
    const result = markdownToDisplay('@[Alice](a:user)@[Bob](b:user)');

    expect(result.displayText).toBe('@Alice@Bob');
    expect(result.mentions).toEqual([
      { start: 0, end: 6, label: 'Alice', id: 'a', type: 'user' },
      { start: 6, end: 10, label: 'Bob', id: 'b', type: 'user' },
    ]);
  });
});

describe('displayToMarkdown', () => {
  it('given plain text with no mentions, should return text unchanged', () => {
    const result = displayToMarkdown('hello world', []);

    expect(result).toBe('hello world');
  });

  it('given display text with a single mention, should reconstruct markdown', () => {
    const mentions: TrackedMention[] = [
      { start: 0, end: 8, label: 'My Page', id: 'abc123', type: 'page' },
    ];
    const result = displayToMarkdown('@My Page', mentions);

    expect(result).toBe('@[My Page](abc123:page)');
  });

  it('given display text with mention in context, should reconstruct markdown', () => {
    const mentions: TrackedMention[] = [
      { start: 6, end: 12, label: 'Alice', id: 'user1', type: 'user' },
    ];
    const result = displayToMarkdown('Hello @Alice world', mentions);

    expect(result).toBe('Hello @[Alice](user1:user) world');
  });

  it('given display text with multiple mentions, should reconstruct all', () => {
    const mentions: TrackedMention[] = [
      { start: 4, end: 10, label: 'Alice', id: 'a', type: 'user' },
      { start: 15, end: 19, label: 'Doc', id: 'd', type: 'page' },
    ];
    const result = displayToMarkdown('Hey @Alice and @Doc bye', mentions);

    expect(result).toBe('Hey @[Alice](a:user) and @[Doc](d:page) bye');
  });

  it('given roundtrip, should preserve markdown', () => {
    const original = 'Hello @[Alice](user1:user) and @[My Doc](doc1:page) bye';
    const { displayText, mentions } = markdownToDisplay(original);
    const roundtripped = displayToMarkdown(displayText, mentions);

    expect(roundtripped).toBe(original);
  });

  it('given multiple roundtrips, should remain stable', () => {
    const original = 'Check @[Report](r1:page) cc @[Bob](b1:user)';

    const first = markdownToDisplay(original);
    const markdown1 = displayToMarkdown(first.displayText, first.mentions);

    const second = markdownToDisplay(markdown1);
    const markdown2 = displayToMarkdown(second.displayText, second.mentions);

    expect(markdown1).toBe(original);
    expect(markdown2).toBe(original);
  });
});
