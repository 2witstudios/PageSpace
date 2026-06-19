import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractFileIds, rewriteCanvasAssets } from '../asset-pipeline';

vi.mock('server-only', () => ({}));

// ---------------------------------------------------------------------------
// extractFileIds — pure, no I/O
// ---------------------------------------------------------------------------

describe('extractFileIds', () => {
  it('given a relative /api/files/{id}/view src attribute, should extract the id', () => {
    const html = '<img src="/api/files/abc123/view">';
    expect(extractFileIds(html)).toEqual(['abc123']);
  });

  it('given an absolute https://pagespace.ai/api/files/{id}/view src, should extract the id', () => {
    const html = '<img src="https://pagespace.ai/api/files/def456/view">';
    expect(extractFileIds(html)).toEqual(['def456']);
  });

  it('given a /api/files/{id}/thumbnail src, should extract the id', () => {
    const html = '<img src="/api/files/thumb789/thumbnail">';
    expect(extractFileIds(html)).toEqual(['thumb789']);
  });

  it('given a CSS url() with /api/files/{id}/view, should extract the id', () => {
    const html = '<style>body { background: url("/api/files/cssId001/view"); }</style>';
    expect(extractFileIds(html)).toEqual(['cssId001']);
  });

  it('given an href attribute pointing to /api/files/{id}/view, should extract the id', () => {
    const html = '<a href="/api/files/href002/view">Download</a>';
    expect(extractFileIds(html)).toEqual(['href002']);
  });

  it('given multiple references to the same id, should deduplicate', () => {
    const html =
      '<img src="/api/files/dup1/view"><img src="/api/files/dup1/view"><img src="/api/files/dup2/view">';
    const ids = extractFileIds(html);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('dup1');
    expect(ids).toContain('dup2');
  });

  it('given an external URL with no /api/files/ path, should NOT extract it', () => {
    const html = '<img src="https://example.com/photo.jpg">';
    expect(extractFileIds(html)).toEqual([]);
  });

  it('given a data:image URI, should NOT extract it', () => {
    const html = '<img src="data:image/png;base64,iVBORw0KGgo=">';
    expect(extractFileIds(html)).toEqual([]);
  });

  it('given no file references, should return an empty array', () => {
    expect(extractFileIds('<p>Hello world</p>')).toEqual([]);
  });

  it('given an empty string, should return an empty array', () => {
    expect(extractFileIds('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rewriteCanvasAssets — async, DB + S3 mocked
// ---------------------------------------------------------------------------

const mockDb = {
  query: {
    pages: {
      findMany: vi.fn(),
    },
  },
};

vi.mock('../published-storage', () => ({
  buildAssetUrl: vi.fn((hash: string) => `https://cdn.example.com/assets/${hash}`),
  copyAssetToPublishBucket: vi.fn().mockResolvedValue(undefined),
  getPublishAssetBaseUrl: vi.fn().mockReturnValue('https://cdn.example.com'),
}));

describe('rewriteCanvasAssets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.pages.findMany.mockResolvedValue([]);
  });

  it('given no file IDs in the HTML, should return the HTML unchanged', async () => {
    const html = '<p>No files here</p>';
    const result = await rewriteCanvasAssets({ html, db: mockDb as never });
    expect(result.html).toBe(html);
    expect(mockDb.query.pages.findMany).not.toHaveBeenCalled();
  });

  it('given a file ID that resolves to a page with contentHash, should rewrite the URL to CDN and copy the asset', async () => {
    const html = '<img src="/api/files/fileId1/view">';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'fileId1', contentHash: 'hash001', mimeType: 'image/png' },
    ]);

    const result = await rewriteCanvasAssets({ html, db: mockDb as never });

    expect(result.html).toContain('https://cdn.example.com/assets/hash001');
    expect(result.html).not.toContain('/api/files/fileId1/view');
  });

  it('given a file ID that cannot be resolved in the DB, should leave the URL as-is (graceful degradation)', async () => {
    const html = '<img src="/api/files/missingId/view">';
    mockDb.query.pages.findMany.mockResolvedValue([]); // not found

    const result = await rewriteCanvasAssets({ html, db: mockDb as never });

    expect(result.html).toContain('/api/files/missingId/view');
  });

  it('given a page with no contentHash, should leave that file URL as-is', async () => {
    const html = '<img src="/api/files/noHashId/view">';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'noHashId', contentHash: null, mimeType: 'image/jpeg' },
    ]);

    const result = await rewriteCanvasAssets({ html, db: mockDb as never });

    expect(result.html).toContain('/api/files/noHashId/view');
  });

  it('given multiple distinct file IDs, should batch-query the DB once and rewrite all resolved URLs', async () => {
    const html =
      '<img src="/api/files/f1/view"><img src="/api/files/f2/view">';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'f1', contentHash: 'h1', mimeType: 'image/png' },
      { id: 'f2', contentHash: 'h2', mimeType: 'image/jpeg' },
    ]);

    const result = await rewriteCanvasAssets({ html, db: mockDb as never });

    expect(mockDb.query.pages.findMany).toHaveBeenCalledTimes(1);
    expect(result.html).toContain('https://cdn.example.com/assets/h1');
    expect(result.html).toContain('https://cdn.example.com/assets/h2');
  });
});
