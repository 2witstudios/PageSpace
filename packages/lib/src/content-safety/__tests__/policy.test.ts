import { describe, it, expect } from 'vitest';
import {
  CONTENT_BLOCKED_MESSAGE,
  ContentBlockedError,
  normalizeContentHash,
  normalizeContentHashes,
  requiresGlobalPurge,
  allowsGlobalTakedown,
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
});

describe('allowsGlobalTakedown', () => {
  it('lets illegal content be purged for every tenant', () => {
    expect(allowsGlobalTakedown('csam')).toBe(true);
    expect(allowsGlobalTakedown('malware')).toBe(true);
    expect(allowsGlobalTakedown('illegal_other')).toBe(true);
  });

  it('never lets a policy case purge a hash', () => {
    expect(allowsGlobalTakedown('policy')).toBe(false);
  });
});
