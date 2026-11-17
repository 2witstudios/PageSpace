import { describe, it, expect } from 'vitest';
import { extractStoredFileReferenceIds, pageContentCanReferenceFiles } from '../stored-file-references';

describe('extractStoredFileReferenceIds', () => {
  it('given /api/files/{id}/view, thumbnail and download references, should return each id once', () => {
    const content = [
      '<img src="/api/files/page-a/view">',
      '<img src="/api/files/page-b/thumbnail?w=200">',
      '<a href="/api/files/page-c/download?filename=x.pdf">x</a>',
      '![again](/api/files/page-a/view)',
    ].join('\n');

    expect(extractStoredFileReferenceIds(content).sort()).toEqual(['page-a', 'page-b', 'page-c']);
  });

  it('given an absolute URL on any host, should still return the id (the path is what the app serves)', () => {
    expect(extractStoredFileReferenceIds('<img src="https://app.example.com/api/files/page-a/view">')).toEqual(['page-a']);
  });

  it('given the /dashboard/{driveId}/{pageId}/view form, should return the page id', () => {
    expect(extractStoredFileReferenceIds("background: url('/dashboard/drive-1/page-z/view');")).toEqual(['page-z']);
  });

  it('given a content-hash id, should return it', () => {
    const hash = 'ab'.repeat(32);
    expect(extractStoredFileReferenceIds(`<img src="/api/files/${hash}/view">`)).toEqual([hash]);
  });

  it('given no internal file references, should return nothing', () => {
    expect(extractStoredFileReferenceIds('<p>see /api/filesystem and https://example.com/a.png</p>')).toEqual([]);
    expect(extractStoredFileReferenceIds('')).toEqual([]);
  });

  it('given a trailing slash (Next.js redirects it to the slashless route), should still return the id', () => {
    const content = [
      '<img src="/api/files/page-a/view/">',
      '<img src="/api/files/page-b/thumbnail/?w=1">',
      "url('/dashboard/drive-1/page-c/view/')",
    ].join('\n');
    expect(extractStoredFileReferenceIds(content).sort()).toEqual(['page-a', 'page-b', 'page-c']);
  });

  it('given a longer path that merely starts like a reference, should not match it', () => {
    expect(extractStoredFileReferenceIds('/api/files/page-a/viewer')).toEqual([]);
  });
});

describe('pageContentCanReferenceFiles', () => {
  it('should be true for DOCUMENT and CANVAS pages only', () => {
    expect(pageContentCanReferenceFiles('DOCUMENT')).toBe(true);
    expect(pageContentCanReferenceFiles('CANVAS')).toBe(true);
    expect(pageContentCanReferenceFiles('FILE')).toBe(false);
    expect(pageContentCanReferenceFiles('AI_CHAT')).toBe(false);
  });
});
