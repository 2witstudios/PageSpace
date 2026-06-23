import { describe, it, expect } from 'vitest';
import { parsePageUrl, extractPageUrls } from '../page-url-parser';

describe('parsePageUrl', () => {
  it('parses relative dashboard URL', () => {
    expect(parsePageUrl('/dashboard/abc/xyz')).toEqual({ driveId: 'abc', pageId: 'xyz' });
  });

  it('parses absolute dashboard URL', () => {
    expect(parsePageUrl('https://pagespace.ai/dashboard/abc/xyz')).toEqual({
      driveId: 'abc',
      pageId: 'xyz',
    });
  });

  it('parses deep-link redirect /p/{pageId}', () => {
    expect(parsePageUrl('/p/xyz')).toEqual({ pageId: 'xyz', driveId: undefined });
  });

  it('returns null for share links /s/{token}', () => {
    expect(parsePageUrl('/s/sometoken')).toBeNull();
  });

  it('returns null for non-PageSpace URLs', () => {
    expect(parsePageUrl('https://google.com')).toBeNull();
    expect(parsePageUrl('https://google.com/dashboard/abc/xyz')).toBeNull();
    expect(parsePageUrl('https://evil.com/dashboard/abc/xyz')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parsePageUrl('')).toBeNull();
  });

  it('handles absolute URL on any origin (not just pagespace.ai)', () => {
    expect(parsePageUrl('https://localhost:3000/dashboard/abc/xyz')).toEqual({
      driveId: 'abc',
      pageId: 'xyz',
    });
  });
});

describe('extractPageUrls', () => {
  it('extracts two different internal URLs from text', () => {
    const text = 'check /dashboard/abc/xyz and /p/xyz2';
    const result = extractPageUrls(text);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ driveId: 'abc', pageId: 'xyz' });
    expect(result).toContainEqual({ pageId: 'xyz2', driveId: undefined });
  });

  it('deduplicates the same URL appearing twice (by pageId)', () => {
    const text = 'see /dashboard/abc/xyz here and /dashboard/abc/xyz there';
    const result = extractPageUrls(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ driveId: 'abc', pageId: 'xyz' });
  });

  it('returns empty array for text with no internal URLs', () => {
    expect(extractPageUrls('hello world no links here')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractPageUrls('')).toEqual([]);
  });

  it('ignores share links and external URLs', () => {
    const text = 'shared /s/tok and https://google.com';
    expect(extractPageUrls(text)).toEqual([]);
  });

  it('extracts from absolute URLs embedded in text', () => {
    const text = 'visit https://pagespace.ai/dashboard/d1/p1 for more';
    const result = extractPageUrls(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ driveId: 'd1', pageId: 'p1' });
  });
});
