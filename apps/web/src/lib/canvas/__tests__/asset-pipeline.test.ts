import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractFileIds, rewriteCanvasAssets } from '../asset-pipeline';

vi.mock('server-only', () => ({}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { warn: vi.fn() } },
}));

const canUserViewPage = vi.fn();
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: (...args: unknown[]) => canUserViewPage(...args),
}));

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

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

  it('given a dashboard file page /view src, should extract the page id', () => {
    const html = '<img src="/dashboard/drive123/page456/view">';
    expect(extractFileIds(html)).toEqual(['page456']);
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

  it('given a longer endpoint that starts with /view, should not extract a partial file reference', () => {
    const html = '<img src="/api/files/notARealFile/viewer">';
    expect(extractFileIds(html)).toEqual([]);
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
  buildAssetKey: vi.fn((hash: string) => `assets/${hash}`),
  buildAssetUrlFromKey: vi.fn((key: string) => `https://cdn.example.com/${key}`),
  copyObjectToPublishBucket: vi.fn().mockResolvedValue(undefined),
  getPublishAssetBaseUrl: vi.fn().mockReturnValue('https://cdn.example.com'),
}));

describe('rewriteCanvasAssets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.pages.findMany.mockResolvedValue([]);
    canUserViewPage.mockResolvedValue(true);
  });

  it('given no file IDs in the HTML, should return the HTML unchanged', async () => {
    const html = '<p>No files here</p>';
    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });
    expect(result.html).toBe(html);
    expect(mockDb.query.pages.findMany).not.toHaveBeenCalled();
  });

  it('given a longer endpoint that starts with /view, should leave it unchanged without querying files', async () => {
    const html = '<img src="/api/files/notARealFile/viewer">';
    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    expect(result.html).toBe(html);
    expect(mockDb.query.pages.findMany).not.toHaveBeenCalled();
  });

  it('given a file ID that resolves to a page with contentHash, should rewrite the URL to CDN and copy the asset', async () => {
    const html = '<img src="/api/files/fileId1/view">';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'fileId1', contentHash: HASH_A, mimeType: 'image/png', extractionMetadata: null },
    ]);

    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    expect(result.html).toContain(`https://cdn.example.com/assets/${HASH_A}`);
    expect(result.html).not.toContain('/api/files/fileId1/view');
    const { copyObjectToPublishBucket } = await import('../published-storage');
    expect(copyObjectToPublishBucket).toHaveBeenCalledWith({
      id: 'fileId1',
      kind: 'view',
      sourceKey: `files/${HASH_A}/original`,
      assetKey: `assets/${HASH_A}`,
      contentType: 'image/png',
    });
  });

  it('given a dashboard file page /view URL with matching drive, should rewrite it to CDN', async () => {
    const html = '<img src="https://pagespace.ai/dashboard/drive-1/fileId1/view">';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'fileId1', driveId: 'drive-1', contentHash: HASH_A, mimeType: 'image/png', extractionMetadata: null },
    ]);

    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    expect(result.html).toContain(`https://cdn.example.com/assets/${HASH_A}`);
    expect(result.html).not.toContain('/dashboard/drive-1/fileId1/view');
  });

  it('given a dashboard file page /view URL with a mismatched drive, should not copy or rewrite it', async () => {
    const html = '<img src="/dashboard/attacker-drive/fileId1/view">';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'fileId1', driveId: 'real-drive', contentHash: HASH_A, mimeType: 'image/png', extractionMetadata: null },
    ]);

    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    const { copyObjectToPublishBucket } = await import('../published-storage');
    expect(copyObjectToPublishBucket).not.toHaveBeenCalled();
    expect(result.html).toContain('/dashboard/attacker-drive/fileId1/view');
  });

  it('given a file ID that cannot be resolved in the DB, should leave the URL as-is (graceful degradation)', async () => {
    const html = '<img src="/api/files/missingId/view">';
    mockDb.query.pages.findMany.mockResolvedValue([]); // not found

    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    expect(result.html).toContain('/api/files/missingId/view');
  });

  it('given a page with no contentHash, should leave that file URL as-is', async () => {
    const html = '<img src="/api/files/noHashId/view">';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'noHashId', contentHash: null, mimeType: 'image/jpeg', extractionMetadata: null },
    ]);

    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    expect(result.html).toContain('/api/files/noHashId/view');
  });

  it('given a page with a non-content-address hash, should not copy or rewrite it', async () => {
    const html = '<img src="/api/files/hostileHash/view">';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'hostileHash', contentHash: '../private-object', mimeType: 'image/png', extractionMetadata: null },
    ]);

    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    const { copyObjectToPublishBucket } = await import('../published-storage');
    expect(copyObjectToPublishBucket).not.toHaveBeenCalled();
    expect(result.html).toContain('/api/files/hostileHash/view');
  });

  it('given multiple distinct file IDs, should batch-query the DB once and rewrite all resolved URLs', async () => {
    const html =
      '<img src="/api/files/f1/view"><img src="/api/files/f2/view">';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'f1', contentHash: HASH_A, mimeType: 'image/png', extractionMetadata: null },
      { id: 'f2', contentHash: HASH_B, mimeType: 'image/jpeg', extractionMetadata: null },
    ]);

    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    expect(mockDb.query.pages.findMany).toHaveBeenCalledTimes(1);
    expect(result.html).toContain(`https://cdn.example.com/assets/${HASH_A}`);
    expect(result.html).toContain(`https://cdn.example.com/assets/${HASH_B}`);
  });

  it('given the publisher cannot view a referenced file, should not copy or rewrite it', async () => {
    const html = '<img src="/api/files/privateFile/view">';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'privateFile', contentHash: HASH_C, mimeType: 'image/png', extractionMetadata: null },
    ]);
    canUserViewPage.mockResolvedValue(false);

    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    const { copyObjectToPublishBucket } = await import('../published-storage');
    expect(canUserViewPage).toHaveBeenCalledWith('user-1', 'privateFile');
    expect(copyObjectToPublishBucket).not.toHaveBeenCalled();
    expect(result.html).toContain('/api/files/privateFile/view');
  });

  it('given a thumbnail reference with metadata, should copy and rewrite the thumbnail cache object', async () => {
    const html = '<video poster="/api/files/videoId/thumbnail"></video>';
    mockDb.query.pages.findMany.mockResolvedValue([
      {
        id: 'videoId',
        contentHash: HASH_C,
        mimeType: 'video/mp4',
        extractionMetadata: { thumbnailKey: 'cache/abcd1234/thumbnail.webp' },
      },
    ]);

    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    const { copyObjectToPublishBucket } = await import('../published-storage');
    expect(copyObjectToPublishBucket).toHaveBeenCalledWith({
      id: 'videoId',
      kind: 'thumbnail',
      sourceKey: 'cache/abcd1234/thumbnail.webp',
      assetKey: 'assets/cache/abcd1234/thumbnail.webp',
      contentType: 'image/webp',
    });
    expect(result.html).toContain('https://cdn.example.com/assets/cache/abcd1234/thumbnail.webp');
    expect(result.html).not.toContain('/api/files/videoId/thumbnail');
  });

  it('given a thumbnail reference without valid thumbnail metadata, should leave the URL as-is', async () => {
    const html = '<video poster="/api/files/videoId/thumbnail"></video>';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'videoId', contentHash: HASH_C, mimeType: 'video/mp4', extractionMetadata: null },
    ]);

    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    expect(result.html).toContain('/api/files/videoId/thumbnail');
  });

  it('given an asset copy fails, should leave that file URL as-is', async () => {
    const html = '<img src="/api/files/fileId1/view">';
    mockDb.query.pages.findMany.mockResolvedValue([
      { id: 'fileId1', contentHash: HASH_A, mimeType: 'image/png', extractionMetadata: null },
    ]);
    const { copyObjectToPublishBucket } = await import('../published-storage');
    vi.mocked(copyObjectToPublishBucket).mockRejectedValueOnce(new Error('copy failed'));

    const result = await rewriteCanvasAssets({ html, userId: 'user-1', db: mockDb as never });

    expect(result.html).toContain('/api/files/fileId1/view');
  });
});
