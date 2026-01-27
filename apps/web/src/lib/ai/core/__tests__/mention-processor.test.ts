import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    ai: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import {
  processMentionsInMessage,
  hasMentions,
  extractPageIds,
} from '../mention-processor';

describe('processMentionsInMessage', () => {
  describe('given a message with page mentions', () => {
    it('should extract a single page mention', () => {
      const result = processMentionsInMessage('Check @[My Doc](abc123:page) for details');
      expect(result.pageIds).toEqual(['abc123']);
      expect(result.mentions).toEqual([{ id: 'abc123', label: 'My Doc', type: 'page' }]);
    });

    it('should extract multiple page mentions', () => {
      const result = processMentionsInMessage(
        'Compare @[Doc A](id1:page) with @[Doc B](id2:page)'
      );
      expect(result.pageIds).toEqual(['id1', 'id2']);
      expect(result.mentions).toHaveLength(2);
    });
  });

  describe('given a message with non-page mentions', () => {
    it('should not include user mentions in pageIds', () => {
      const result = processMentionsInMessage('Hello @[Alice](user1:user)');
      expect(result.pageIds).toEqual([]);
      expect(result.mentions).toEqual([]);
    });
  });

  describe('given a message with no mentions', () => {
    it('should return empty arrays', () => {
      const result = processMentionsInMessage('Hello world');
      expect(result.pageIds).toEqual([]);
      expect(result.mentions).toEqual([]);
    });
  });
});

describe('hasMentions', () => {
  it('should return true when content contains a mention', () => {
    expect(hasMentions('See @[My Doc](abc:page)')).toBe(true);
  });

  it('should return false when content has no mentions', () => {
    expect(hasMentions('Hello world')).toBe(false);
  });

  describe('bounded quantifier enforcement', () => {
    it('should match labels up to 500 characters', () => {
      const label = 'a'.repeat(500);
      expect(hasMentions(`@[${label}](id:page)`)).toBe(true);
    });

    it('should not match labels exceeding 500 characters', () => {
      const label = 'a'.repeat(501);
      expect(hasMentions(`@[${label}](id:page)`)).toBe(false);
    });

    it('should match IDs up to 200 characters', () => {
      const id = 'a'.repeat(200);
      expect(hasMentions(`@[Label](${id}:page)`)).toBe(true);
    });

    it('should not match IDs exceeding 200 characters', () => {
      const id = 'a'.repeat(201);
      expect(hasMentions(`@[Label](${id}:page)`)).toBe(false);
    });

    it('should match types up to 200 characters', () => {
      const type = 'a'.repeat(200);
      expect(hasMentions(`@[Label](id:${type})`)).toBe(true);
    });

    it('should not match types exceeding 200 characters', () => {
      const type = 'a'.repeat(201);
      expect(hasMentions(`@[Label](id:${type})`)).toBe(false);
    });
  });
});

describe('extractPageIds', () => {
  it('should extract page IDs only', () => {
    const ids = extractPageIds(
      'See @[Doc](page1:page) and @[User](user1:user) and @[Other](page2:page)'
    );
    expect(ids).toEqual(['page1', 'page2']);
  });

  it('should return empty array when no page mentions exist', () => {
    expect(extractPageIds('No mentions here')).toEqual([]);
  });

  it('should respect bounded quantifiers', () => {
    const longLabel = 'a'.repeat(501);
    expect(extractPageIds(`@[${longLabel}](id:page)`)).toEqual([]);
  });
});
