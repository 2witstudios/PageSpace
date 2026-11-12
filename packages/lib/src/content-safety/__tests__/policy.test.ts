import { describe, it, expect } from 'vitest';
import {
  CONTENT_BLOCKED_MESSAGE,
  CONTENT_BLOCKED_STATUS,
  CONTENT_BLOCK_CATEGORIES,
  ContentBlockedError,
  isContentBlockCategory,
  isValidContentHash,
  normalizeContentHash,
  normalizeContentHashes,
  requiresGlobalPurge,
} from '../policy';

const HASH = 'a1'.repeat(32);

describe('normalizeContentHash', () => {
  it('returns a lowercase sha256 hex hash unchanged', () => {
    expect(normalizeContentHash(HASH)).toBe(HASH);
  });

  it('lowercases an uppercase hash, so one blob cannot be spelled two ways', () => {
    expect(normalizeContentHash(HASH.toUpperCase())).toBe(HASH);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeContentHash(`  ${HASH}\n`)).toBe(HASH);
  });

  it.each([
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['non-hex characters', 'g'.repeat(64)],
    ['a storage key rather than a hash', `files/${HASH}/original`],
    ['empty', ''],
  ])('returns null for %s', (_label, input) => {
    expect(normalizeContentHash(input)).toBeNull();
  });

  it.each([[null], [undefined], [42], [{}]])('returns null for non-string %p', (input) => {
    expect(normalizeContentHash(input)).toBeNull();
  });
});

describe('isValidContentHash', () => {
  it('accepts any casing of a sha256 hex hash', () => {
    expect(isValidContentHash(HASH)).toBe(true);
    expect(isValidContentHash(HASH.toUpperCase())).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidContentHash('nope')).toBe(false);
  });
});

describe('normalizeContentHashes', () => {
  it('normalizes, drops invalid entries and de-duplicates', () => {
    const other = 'b2'.repeat(32);
    expect(normalizeContentHashes([HASH, HASH.toUpperCase(), 'junk', other])).toEqual([HASH, other]);
  });

  it('returns an empty list for no input', () => {
    expect(normalizeContentHashes([])).toEqual([]);
  });
});

describe('requiresGlobalPurge', () => {
  it('purges CSAM and malware everywhere, for every tenant holding the bytes', () => {
    expect(requiresGlobalPurge('csam')).toBe(true);
    expect(requiresGlobalPurge('malware')).toBe(true);
  });

  it('keeps other categories scoped, so one tenant\'s violation does not remove another\'s file', () => {
    expect(requiresGlobalPurge('illegal_other')).toBe(false);
    expect(requiresGlobalPurge('policy')).toBe(false);
  });

  it('has a decision for every category', () => {
    for (const category of CONTENT_BLOCK_CATEGORIES) {
      expect(typeof requiresGlobalPurge(category)).toBe('boolean');
    }
  });
});

describe('isContentBlockCategory', () => {
  it('accepts known categories and rejects everything else', () => {
    expect(isContentBlockCategory('csam')).toBe(true);
    expect(isContentBlockCategory('spam')).toBe(false);
    expect(isContentBlockCategory(undefined)).toBe(false);
  });
});

describe('ContentBlockedError', () => {
  it('carries the hash for callers and logs, but a neutral message for users', () => {
    const error = new ContentBlockedError(HASH);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ContentBlockedError');
    expect(error.contentHash).toBe(HASH);
    expect(error.message).toBe(CONTENT_BLOCKED_MESSAGE);
    expect(error.message).not.toContain(HASH);
  });

  it('never says why the upload was refused', () => {
    expect(CONTENT_BLOCKED_MESSAGE).toBe("This file can't be uploaded");
    expect(CONTENT_BLOCKED_MESSAGE).not.toMatch(/block|illegal|csam|malware|policy|safety|abuse/i);
  });

  it('maps to an ordinary 4xx', () => {
    expect(CONTENT_BLOCKED_STATUS).toBe(422);
  });
});
