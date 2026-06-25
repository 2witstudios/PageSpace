/**
 * Pure policy for extracted-document-text handling (GDPR #973).
 *
 * Extracted text is PII-bearing. It is always returned to the caller (which
 * persists it to the DB for search), but the redundant object-store cache copy
 * must NEVER be written in plaintext: it is persisted only when it can be
 * encrypted at rest (i.e. an encryption key is configured).
 */
import { describe, it, expect } from 'vitest';
import { cleanExtractedText, shouldPersistExtractedText } from '../extracted-text-policy';

describe('cleanExtractedText', () => {
  it('given text with null bytes, should strip them', () => {
    expect(cleanExtractedText('Hello\0World\0')).toBe('HelloWorld');
  });

  it('given surrounding whitespace, should trim', () => {
    expect(cleanExtractedText('  spaced  ')).toBe('spaced');
  });

  it('given clean text, should return it unchanged', () => {
    expect(cleanExtractedText('plain text')).toBe('plain text');
  });
});

describe('shouldPersistExtractedText', () => {
  it('given an encryption key is available, should persist (encrypted at rest)', () => {
    expect(shouldPersistExtractedText({ hasEncryptionKey: true })).toBe(true);
  });

  it('given NO encryption key, should NOT persist plaintext PII to the cache', () => {
    expect(shouldPersistExtractedText({ hasEncryptionKey: false })).toBe(false);
  });
});
