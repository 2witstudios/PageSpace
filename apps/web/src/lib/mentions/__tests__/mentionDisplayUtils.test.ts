import { describe, it, expect } from 'vitest';
import {
  extractMentions,
  toDisplayValue,
  toRawValue,
} from '../mentionDisplayUtils';

describe('mentionDisplayUtils', () => {
  describe('extractMentions', () => {
    it('given plain text, should return empty array', () => {
      expect(extractMentions('hello world')).toEqual([]);
    });

    it('given a single page mention, should extract label, id, and type', () => {
      const result = extractMentions('@[My Page](abc123:page)');
      expect(result).toEqual([
        { label: 'My Page', id: 'abc123', type: 'page' },
      ]);
    });

    it('given a user mention, should extract correctly', () => {
      const result = extractMentions('@[Alice](user1:user)');
      expect(result).toEqual([
        { label: 'Alice', id: 'user1', type: 'user' },
      ]);
    });

    it('given multiple mentions, should extract all in order', () => {
      const result = extractMentions(
        'Hey @[Doc](id1:page) and @[Bob](id2:user) bye'
      );
      expect(result).toEqual([
        { label: 'Doc', id: 'id1', type: 'page' },
        { label: 'Bob', id: 'id2', type: 'user' },
      ]);
    });

    it('given duplicate labels with different IDs, should extract both', () => {
      const result = extractMentions(
        '@[README](abc:page) and @[README](def:page)'
      );
      expect(result).toEqual([
        { label: 'README', id: 'abc', type: 'page' },
        { label: 'README', id: 'def', type: 'page' },
      ]);
    });
  });

  describe('toDisplayValue', () => {
    it('given plain text, should return unchanged', () => {
      expect(toDisplayValue('hello world')).toBe('hello world');
    });

    it('given a page mention, should strip brackets and ID', () => {
      expect(toDisplayValue('@[My Page](abc123:page)')).toBe('@My Page');
    });

    it('given mixed content, should strip all mention IDs', () => {
      expect(
        toDisplayValue('Hey @[Doc](id1:page) and @[Bob](id2:user) bye')
      ).toBe('Hey @Doc and @Bob bye');
    });

    it('given text with no mentions, should return unchanged', () => {
      expect(toDisplayValue('Just some @plain text')).toBe(
        'Just some @plain text'
      );
    });
  });

  describe('toRawValue', () => {
    it('given display text with no mentions, should return unchanged', () => {
      expect(toRawValue('hello world', [])).toBe('hello world');
    });

    it('given display text with a mention, should re-inject the ID', () => {
      const result = toRawValue('@My Page', [
        { label: 'My Page', id: 'abc123', type: 'page' },
      ]);
      expect(result).toBe('@[My Page](abc123:page)');
    });

    it('given multiple mentions, should re-inject all IDs in order', () => {
      const result = toRawValue('Hey @Doc and @Bob bye', [
        { label: 'Doc', id: 'id1', type: 'page' },
        { label: 'Bob', id: 'id2', type: 'user' },
      ]);
      expect(result).toBe('Hey @[Doc](id1:page) and @[Bob](id2:user) bye');
    });

    it('given duplicate labels, should map them in order', () => {
      const result = toRawValue('@README and @README', [
        { label: 'README', id: 'abc', type: 'page' },
        { label: 'README', id: 'def', type: 'page' },
      ]);
      expect(result).toBe(
        '@[README](abc:page) and @[README](def:page)'
      );
    });

    it('given a mention that was deleted from text, should skip it', () => {
      const result = toRawValue('some text', [
        { label: 'Deleted Page', id: 'gone', type: 'page' },
      ]);
      expect(result).toBe('some text');
    });

    it('should round-trip: toRawValue(toDisplayValue(raw), extractMentions(raw)) === raw', () => {
      const raw = 'Check @[My Page](abc:page) and @[Notes](xyz:page) please';
      const display = toDisplayValue(raw);
      const mentions = extractMentions(raw);
      expect(toRawValue(display, mentions)).toBe(raw);
    });
  });
});
