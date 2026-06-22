import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external deps before importing
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
      drives: { findFirst: vi.fn() },
      publishedPages: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id' },
  drives: { id: 'drives.id' },
}));

vi.mock('@pagespace/db/schema/published-pages', () => ({
  publishedPages: { pageId: 'publishedPages.pageId' },
}));

vi.mock('../published-storage', () => ({
  buildPublishedKey: vi.fn((sub: string, path: string) => `published/${sub}/${path || 'index'}.html`),
  putPublishedArtifact: vi.fn().mockResolvedValue(undefined),
  deletePublishedArtifact: vi.fn().mockResolvedValue(undefined),
  isPublishConfigured: vi.fn().mockReturnValue(true),
  getPublishAssetBaseUrl: vi.fn().mockReturnValue('https://cdn.example.com'),
}));

vi.mock('../render-published', () => ({
  renderPublishedPage: vi.fn(({ html }) => `<html>${html}</html>`),
}));

vi.mock('../asset-pipeline', () => ({
  rewriteCanvasAssets: vi.fn(async ({ html }: { html: string }) => ({ html })),
  extractAndStripOgMeta: vi.fn((html: string) => ({
    meta: { faviconHref: null, ogImageUrl: null, ogDescription: null },
    html,
  })),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('@pagespace/lib/services/drive-guards', () => ({
  isHomeDrive: vi.fn().mockReturnValue(false),
}));

vi.mock('@pagespace/lib/validators/subdomain', () => ({
  normalizeSubdomain: vi.fn((s: string) => s.toLowerCase()),
  validatePublishSubdomain: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock('@pagespace/lib/services/subdomain-allocation', () => ({
  isUniqueViolation: vi.fn().mockReturnValue(false),
}));

vi.mock('@pagespace/lib/utils/utils', () => ({
  slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, '-')),
}));

import { db } from '@pagespace/db/db';
import { publishCanvasPage, publishHomePageAtRoot } from '../publish-page';

describe('publishCanvasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a valid canvas page with an existing subdomain, should publish successfully', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    } as any);
    vi.mocked(db.query.drives.findFirst).mockResolvedValue({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD',
    } as any);
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(null);

    const result = await publishCanvasPage({
      pageId: 'page-1',
      driveId: 'drive-1',
      userId: 'user-1',
    });

    expect(result.subdomain).toBe('my-drive');
    expect(result.url).toContain('my-drive.pagespace.site');
  });

  it('given a non-canvas page, should throw an error', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: 'page-1', type: 'DOCUMENT', title: 'Doc', content: '', driveId: 'drive-1',
    } as any);

    await expect(publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1',
    })).rejects.toThrow('Only canvas pages can be published');
  });

  it('given a page that does not exist, should throw', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(null);

    await expect(publishCanvasPage({
      pageId: 'missing', driveId: 'drive-1', userId: 'user-1',
    })).rejects.toThrow('Page not found');
  });

  it('given an explicit empty path, should publish at root (path = "")', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: 'page-1', type: 'CANVAS', title: 'Home', content: '<div>home</div>', driveId: 'drive-1',
    } as any);
    vi.mocked(db.query.drives.findFirst).mockResolvedValue({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD',
    } as any);
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(null);

    const result = await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', path: '',
    });

    expect(result.path).toBe('');
    expect(result.url).toBe('https://my-drive.pagespace.site/');
  });
});

describe('publishHomePageAtRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a drive with no homePageId, should return null', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue({
      id: 'drive-1', homePageId: null, publishSubdomain: 'sub', kind: 'STANDARD',
    } as any);

    const result = await publishHomePageAtRoot('drive-1', 'user-1');
    expect(result).toBeNull();
  });

  it('given a drive with no publishSubdomain, should return null', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue({
      id: 'drive-1', homePageId: 'page-1', publishSubdomain: null, kind: 'STANDARD',
    } as any);

    const result = await publishHomePageAtRoot('drive-1', 'user-1');
    expect(result).toBeNull();
  });

  it('given a home page that is not a canvas, should return null', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue({
      id: 'drive-1', homePageId: 'page-1', publishSubdomain: 'sub', kind: 'STANDARD',
    } as any);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: 'page-1', type: 'DOCUMENT',
    } as any);

    const result = await publishHomePageAtRoot('drive-1', 'user-1');
    expect(result).toBeNull();
  });

  it('given a valid canvas home page, should publish at root path', async () => {
    vi.mocked(db.query.drives.findFirst)
      // First call: drive lookup for home-publish checks
      .mockResolvedValueOnce({
        id: 'drive-1', homePageId: 'page-1', publishSubdomain: 'sub', kind: 'STANDARD',
      } as any)
      // Second call: drive lookup inside publishCanvasPage
      .mockResolvedValueOnce({
        id: 'drive-1', slug: 'my-drive', publishSubdomain: 'sub', kind: 'STANDARD',
      } as any);
    vi.mocked(db.query.pages.findFirst)
      // First call: home page type check
      .mockResolvedValueOnce({
        id: 'page-1', type: 'CANVAS',
      } as any)
      // Second call: inside publishCanvasPage
      .mockResolvedValueOnce({
        id: 'page-1', type: 'CANVAS', title: 'Home', content: '<div>home</div>', driveId: 'drive-1',
      } as any);
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(null);

    const result = await publishHomePageAtRoot('drive-1', 'user-1');

    expect(result).not.toBeNull();
    expect(result!.path).toBe('');
    expect(result!.url).toBe('https://sub.pagespace.site/');
  });
});
