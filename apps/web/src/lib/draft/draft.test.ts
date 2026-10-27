import { describe, test, expect } from 'vitest';
import {
  buildDraftKey,
  mergeDrafts,
  shouldPersist,
  draftExpiresAt,
  DRAFT_TTL_MS,
} from './draft';

describe('buildDraftKey', () => {
  test('channel composer key', () => {
    expect(buildDraftKey('channel', 'page-123')).toBe('compose:channel:page-123');
  });

  test('dm composer key', () => {
    expect(buildDraftKey('dm', 'conv-456')).toBe('compose:dm:conv-456');
  });

  test('ai chat key omits compose: prefix', () => {
    expect(buildDraftKey('ai', 'conv-789')).toBe('ai:conv-789');
  });

  test('thread reply key includes parentId', () => {
    expect(buildDraftKey('channel', 'page-123', 'msg-001')).toBe(
      'thread:channel:page-123:msg-001',
    );
  });

  test('dm thread reply key', () => {
    expect(buildDraftKey('dm', 'conv-456', 'msg-002')).toBe(
      'thread:dm:conv-456:msg-002',
    );
  });

  test('empty parentId falls through to compose key', () => {
    expect(buildDraftKey('channel', 'page-123', '')).toBe('compose:channel:page-123');
  });
});

describe('mergeDrafts', () => {
  test('returns server value when local is empty', () => {
    expect(mergeDrafts('', 'server draft')).toBe('server draft');
  });

  test('returns local value when local has content', () => {
    expect(mergeDrafts('local draft', 'server draft')).toBe('local draft');
  });

  test('returns server value when local is only whitespace', () => {
    expect(mergeDrafts('   ', 'server draft')).toBe('server draft');
  });

  test('returns local value when server is empty', () => {
    expect(mergeDrafts('local draft', '')).toBe('local draft');
  });

  test('returns empty when both are empty', () => {
    expect(mergeDrafts('', '')).toBe('');
  });
});

describe('shouldPersist', () => {
  test('true for non-empty content', () => {
    expect(shouldPersist('hello')).toBe(true);
  });

  test('false for empty string', () => {
    expect(shouldPersist('')).toBe(false);
  });

  test('false for whitespace only', () => {
    expect(shouldPersist('   \n\t  ')).toBe(false);
  });

  test('true for content with surrounding whitespace', () => {
    expect(shouldPersist('  hello  ')).toBe(true);
  });
});

describe('draftExpiresAt', () => {
  test('returns a date 7 days from now', () => {
    const now = Date.now();
    const result = draftExpiresAt(now);
    expect(result.getTime()).toBe(now + DRAFT_TTL_MS);
  });

  test('DRAFT_TTL_MS is 7 days in milliseconds', () => {
    expect(DRAFT_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
