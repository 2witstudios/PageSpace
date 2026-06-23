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
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
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
  // Mirror the real slugify so path-normalization assertions are faithful.
  slugify: vi.fn((s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\w-]+/g, '')
      .replace(/--+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, ''),
  ),
}));

import { db } from '@pagespace/db/db';
import { publishCanvasPage, publishHomePageAtRoot, PublishError } from '../publish-page';

// The mocked `db` keeps the real relational-query return types, so partial test
// fixtures are cast through `unknown` to the row shape (never `any`).
type PageRow = NonNullable<Awaited<ReturnType<typeof db.query.pages.findFirst>>>;
type DriveRow = NonNullable<Awaited<ReturnType<typeof db.query.drives.findFirst>>>;
type PublishedRow = NonNullable<Awaited<ReturnType<typeof db.query.publishedPages.findFirst>>>;

const pageRow = (row: Record<string, unknown>) => row as unknown as PageRow;
const driveRow = (row: Record<string, unknown>) => row as unknown as DriveRow;
const publishedRow = (row: Record<string, unknown>) => row as unknown as PublishedRow;

describe('publishCanvasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a valid canvas page with an existing subdomain, should publish successfully', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({
      pageId: 'page-1',
      driveId: 'drive-1',
      userId: 'user-1',
    });

    expect(result.subdomain).toBe('my-drive');
    expect(result.url).toContain('my-drive.pagespace.site');
  });

  it('given a non-canvas page, should throw an error', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'DOCUMENT', title: 'Doc', content: '', driveId: 'drive-1',
    }));

    await expect(publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1',
    })).rejects.toThrow('Only canvas pages can be published');
  });

  it('given a page that does not exist, should throw', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined);

    await expect(publishCanvasPage({
      pageId: 'missing', driveId: 'drive-1', userId: 'user-1',
    })).rejects.toThrow('Page not found');
  });

  it('given an explicit empty path, should publish at root (path = "")', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Home', content: '<div>home</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', path: '',
    });

    expect(result.path).toBe('');
    expect(result.url).toBe('https://my-drive.pagespace.site/');
  });

  it('given a caller-supplied subdomain, should NOT override the drive\'s existing subdomain', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', subdomain: 'someone-elses-site',
    });

    // The drive already owns 'my-drive'; the caller cannot publish under another subdomain.
    expect(result.subdomain).toBe('my-drive');
    expect(result.url).toContain('my-drive.pagespace.site');
  });

  it('given no existing subdomain, should use the caller subdomain only as an allocation candidate', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: null, kind: 'STANDARD',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', subdomain: 'Chosen-Sub',
    });

    // normalizeSubdomain lowercases the candidate before allocation.
    expect(result.subdomain).toBe('chosen-sub');
  });

  it('given an explicit non-empty path, should normalize it (Foo -> foo)', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', path: 'Foo',
    });

    expect(result.path).toBe('foo');
  });

  it('given a traversal-style path, should canonicalize it (a/../b -> a/b)', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', path: 'a/../b',
    });

    expect(result.path).toBe('a/b');
  });

  it('given a non-empty path that canonicalizes to empty, should fall back to the page id (not root)', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', path: '!!!',
    });

    expect(result.path).toBe('page-1');
  });

  it('throws 404 when the page does not belong to the given drive', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'X', content: '', driveId: 'other-drive',
    }));

    await expect(publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('PublishError carries an HTTP status code for non-canvas pages', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'DOCUMENT', title: 'Doc', content: '', driveId: 'drive-1',
    }));

    await expect(publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(PublishError).toBeDefined();
  });
});

describe('publishHomePageAtRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a drive with no homePageId, should return null', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', homePageId: null, publishSubdomain: 'sub', kind: 'STANDARD',
    }));

    const result = await publishHomePageAtRoot('drive-1', 'user-1');
    expect(result).toBeNull();
  });

  it('given a drive with no publishSubdomain, should return null', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', homePageId: 'page-1', publishSubdomain: null, kind: 'STANDARD',
    }));

    const result = await publishHomePageAtRoot('drive-1', 'user-1');
    expect(result).toBeNull();
  });

  it('given a home page that is not a canvas, should return null', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', homePageId: 'page-1', publishSubdomain: 'sub', kind: 'STANDARD',
    }));
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'DOCUMENT',
    }));

    const result = await publishHomePageAtRoot('drive-1', 'user-1');
    expect(result).toBeNull();
  });

  it('given a valid canvas home page, should publish at root path', async () => {
    vi.mocked(db.query.drives.findFirst)
      // First call: drive lookup for home-publish checks
      .mockResolvedValueOnce(driveRow({
        id: 'drive-1', homePageId: 'page-1', publishSubdomain: 'sub', kind: 'STANDARD',
      }))
      // Second call: drive lookup inside publishCanvasPage
      .mockResolvedValueOnce(driveRow({
        id: 'drive-1', slug: 'my-drive', publishSubdomain: 'sub', kind: 'STANDARD',
      }));
    vi.mocked(db.query.pages.findFirst)
      // First call: home page type check
      .mockResolvedValueOnce(pageRow({
        id: 'page-1', type: 'CANVAS',
      }))
      // Second call: inside publishCanvasPage
      .mockResolvedValueOnce(pageRow({
        id: 'page-1', type: 'CANVAS', title: 'Home', content: '<div>home</div>', driveId: 'drive-1',
      }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishHomePageAtRoot('drive-1', 'user-1');

    expect(result).not.toBeNull();
    expect(result!.path).toBe('');
    expect(result!.url).toBe('https://sub.pagespace.site/');
  });

  it('releases an existing root publication owned by a different page (replacement semantics)', async () => {
    vi.mocked(db.query.drives.findFirst)
      .mockResolvedValueOnce(driveRow({
        id: 'drive-1', homePageId: 'page-new', publishSubdomain: 'sub', kind: 'STANDARD',
      }))
      .mockResolvedValueOnce(driveRow({
        id: 'drive-1', slug: 'my-drive', publishSubdomain: 'sub', kind: 'STANDARD',
      }));
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce(pageRow({ id: 'page-new', type: 'CANVAS' }))
      .mockResolvedValueOnce(pageRow({
        id: 'page-new', type: 'CANVAS', title: 'New Home', content: '<div>x</div>', driveId: 'drive-1',
      }));
    vi.mocked(db.query.publishedPages.findFirst)
      // existingRoot lookup: an OLD page still owns the root path
      .mockResolvedValueOnce(publishedRow({ pageId: 'page-old' }))
      // cleanup lookup inside publishCanvasPage
      .mockResolvedValue(undefined);

    const result = await publishHomePageAtRoot('drive-1', 'user-1');

    // The stale root row must be deleted so the new home page can take the root.
    expect(db.delete).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.path).toBe('');
  });

  it('does NOT delete the root row when it already belongs to the current home page', async () => {
    vi.mocked(db.query.drives.findFirst)
      .mockResolvedValueOnce(driveRow({
        id: 'drive-1', homePageId: 'page-1', publishSubdomain: 'sub', kind: 'STANDARD',
      }))
      .mockResolvedValueOnce(driveRow({
        id: 'drive-1', slug: 'my-drive', publishSubdomain: 'sub', kind: 'STANDARD',
      }));
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce(pageRow({ id: 'page-1', type: 'CANVAS' }))
      .mockResolvedValueOnce(pageRow({
        id: 'page-1', type: 'CANVAS', title: 'Home', content: '<div>x</div>', driveId: 'drive-1',
      }));
    vi.mocked(db.query.publishedPages.findFirst)
      .mockResolvedValueOnce(publishedRow({ pageId: 'page-1' }))
      .mockResolvedValue(undefined);

    const result = await publishHomePageAtRoot('drive-1', 'user-1');

    expect(db.delete).not.toHaveBeenCalled();
    expect(result!.path).toBe('');
  });
});
