import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external deps before importing
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
      drives: { findFirst: vi.fn() },
      publishedPages: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
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
  putPublishedSiteFile: vi.fn().mockResolvedValue(undefined),
  publishedArtifactExists: vi.fn().mockResolvedValue(true),
  deletePublishedArtifact: vi.fn().mockResolvedValue(undefined),
  copyPublishedArtifact: vi.fn().mockResolvedValue(undefined),
  isPublishConfigured: vi.fn().mockReturnValue(true),
  getPublishAssetBaseUrl: vi.fn().mockReturnValue('https://cdn.example.com'),
}));

// Pure builders run for real elsewhere (canvas/site-files.test.ts). Here we
// only assert the wiring — that the lifecycle writes all three site files — so
// stub the builders with deterministic stand-ins.
vi.mock('@pagespace/lib/canvas/site-files', () => ({
  buildRobotsTxt: vi.fn(({ sitemapUrl }: { sitemapUrl: string }) => `robots:${sitemapUrl}`),
  buildSitemapXml: vi.fn((routes: { loc: string }[]) => `sitemap:${routes.map((r) => r.loc).join(',')}`),
  buildNotFoundHtml: vi.fn(({ siteName }: { siteName?: string }) => `404:${siteName ?? ''}`),
}));

vi.mock('../render-published', () => ({
  renderPublishedPage: vi.fn(({ html }) => `<html>${html}</html>`),
}));

vi.mock('../asset-pipeline', () => ({
  rewriteCanvasAssets: vi.fn(async ({ html }: { html: string }) => ({ html })),
  rewriteInterPageLinksForDrive: vi.fn(async ({ html }: { html: string }) => ({ html })),
  extractAndStripOgMeta: vi.fn((html: string) => ({
    meta: { faviconHref: null, ogImageUrl: null, ogDescription: null },
    html,
  })),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../custom-domain-mirror', () => ({
  mirrorPublishedPageToHosts: vi.fn().mockResolvedValue(undefined),
  mirror404ToHosts: vi.fn().mockResolvedValue(undefined),
  getActiveDomainRecords: vi.fn().mockResolvedValue([]),
}));

vi.mock('@pagespace/lib/services/drive-guards', () => ({
  isHomeDrive: vi.fn().mockReturnValue(false),
}));

vi.mock('@pagespace/lib/services/subdomain-allocation', () => ({
  isUniqueViolation: vi.fn().mockReturnValue(false),
}));

// First-publish subdomain allocation is delegated to the shared, race-safe
// allocator (the same one drive creation uses). It normalizes the candidate and
// auto-resolves reserved / taken / malformed values to a unique slug. The stub
// mirrors the normalize step so candidate-derived assertions stay faithful.
vi.mock('@pagespace/lib/services/drive-service', () => ({
  allocatePublishSubdomain: vi.fn((_driveId: string, base: string) => Promise.resolve(base.toLowerCase())),
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
import { putPublishedArtifact, putPublishedSiteFile, publishedArtifactExists, deletePublishedArtifact, copyPublishedArtifact, isPublishConfigured } from '../published-storage';
import { publishCanvasPage, publishHomePageAtRoot, clearPublishedHomeRoot, regeneratePublishedSiteFiles, syncPublishedHomeRoot, republishDriveCanonical, PublishError } from '../publish-page';
import { allocatePublishSubdomain } from '@pagespace/lib/services/drive-service';
import { getActiveDomainRecords } from '../custom-domain-mirror';
import { renderPublishedPage } from '../render-published';
import { extractAndStripOgMeta } from '../asset-pipeline';

// The mocked `db` keeps the real relational-query return types, so partial test
// fixtures are cast through `unknown` to the row shape (never `any`).
type PageRow = NonNullable<Awaited<ReturnType<typeof db.query.pages.findFirst>>>;
type DriveRow = NonNullable<Awaited<ReturnType<typeof db.query.drives.findFirst>>>;

const pageRow = (row: Record<string, unknown>) => row as unknown as PageRow;
const driveRow = (row: Record<string, unknown>) => row as unknown as DriveRow;

describe('publishCanvasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
  });

  it('given a non-home canvas page with an existing subdomain, publishes at its slug only', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD', homePageId: 'other-page',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' });

    expect(result.subdomain).toBe('my-drive');
    expect(result.isHomePage).toBe(false);
    expect(result.url).toBe('https://my-drive.pagespace.site/welcome');
    // No root mirror for a non-home page.
    expect(putPublishedArtifact).toHaveBeenCalledTimes(1);
    expect(putPublishedArtifact).toHaveBeenCalledWith({ subdomain: 'my-drive', path: 'welcome', html: expect.any(String) });
  });

  it('given the drive home page, also mirrors to the subdomain root and returns the root url', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD', homePageId: 'page-1',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' });

    expect(result.isHomePage).toBe(true);
    // Primary URL is the root; the page is also at its slug.
    expect(result.url).toBe('https://my-drive.pagespace.site/');
    expect(result.path).toBe('welcome');
    // Two uploads: the slug artifact + the stable root mirror.
    expect(putPublishedArtifact).toHaveBeenCalledTimes(2);
    expect(putPublishedArtifact).toHaveBeenCalledWith({ subdomain: 'my-drive', path: 'welcome', html: expect.any(String) });
    expect(putPublishedArtifact).toHaveBeenCalledWith({ subdomain: 'my-drive', path: '', html: expect.any(String) });
  });

  it('given a non-canvas page, throws a 400 PublishError', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'DOCUMENT', title: 'Doc', content: '', driveId: 'drive-1',
    }));

    await expect(publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('given a page that does not exist, throws 404', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined);

    await expect(publishCanvasPage({ pageId: 'missing', driveId: 'drive-1', userId: 'user-1' }))
      .rejects.toThrow('Page not found');
  });

  it('throws 404 when the page does not belong to the given drive', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'X', content: '', driveId: 'other-drive',
    }));

    await expect(publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('given a caller-supplied subdomain, does NOT override the drive\'s existing subdomain', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', subdomain: 'someone-elses-site',
    });

    expect(result.subdomain).toBe('my-drive');
  });

  it('given no existing subdomain, uses the caller subdomain only as an allocation candidate', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: null, kind: 'STANDARD', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', subdomain: 'Chosen-Sub',
    });

    // The caller-supplied value is only a candidate base: it is forwarded to the
    // shared allocator (which normalizes + dedupes), never written verbatim.
    expect(allocatePublishSubdomain).toHaveBeenCalledWith('drive-1', 'Chosen-Sub');
    expect(result.subdomain).toBe('chosen-sub');
  });

  it('given no existing subdomain and a reserved candidate, auto-slugs instead of erroring', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'pagespace', publishSubdomain: null, kind: 'STANDARD', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);
    // The allocator resolves the reserved slug to a suffixed, unique subdomain.
    vi.mocked(allocatePublishSubdomain).mockResolvedValueOnce('pagespace-2');

    const result = await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' });

    expect(allocatePublishSubdomain).toHaveBeenCalledWith('drive-1', 'pagespace');
    expect(result.subdomain).toBe('pagespace-2');
    expect(result.url).toBe('https://pagespace-2.pagespace.site/welcome');
  });

  it('given an explicit non-empty path, normalizes it (Foo -> foo)', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', path: 'Foo',
    });

    expect(result.path).toBe('foo');
  });

  it('given a traversal-style path, canonicalizes it (a/../b -> a/b)', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', path: 'a/../b',
    });

    expect(result.path).toBe('a/b');
  });

  it('given an explicit path that canonicalizes to empty, falls back to the page id (never the root)', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    // Both '' and '!!!' canonicalize to empty — a non-home page must not claim the root.
    const empty = await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', path: '' });
    expect(empty.path).toBe('page-1');

    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);
    const garbage = await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', path: '!!!' });
    expect(garbage.path).toBe('page-1');
  });

  it('PublishError carries an HTTP status code', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'DOCUMENT', title: 'Doc', content: '', driveId: 'drive-1',
    }));

    await expect(publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(PublishError).toBeDefined();
  });

  it('response url is the primary host (custom domain) when an active custom domain exists', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'About', content: '<div/>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'STANDARD', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);
    vi.mocked(getActiveDomainRecords).mockResolvedValue([
      { hostname: 'www.acme.com', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);

    const result = await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' });

    // Response URL is the branded primary host — the same canonical host baked
    // into the HTML — so the publish control shows/copies the link visitors should land on.
    expect(result.url).toBe('https://www.acme.com/about');
  });

  it('response url honors an explicitly-selected primary custom domain', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'About', content: '<div/>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'STANDARD', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);
    vi.mocked(getActiveDomainRecords).mockResolvedValue([
      { hostname: 'www.acme.com', createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { hostname: 'docs.acme.com', createdAt: new Date('2026-03-01T00:00:00.000Z'), isPrimary: true },
    ]);

    const result = await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' });

    // docs is newer but flagged primary, so it wins over the earliest-created www.
    expect(result.url).toBe('https://docs.acme.com/about');
  });

  it('uses the subdomain as response URL when no active custom domain exists', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'About', content: '<div/>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'STANDARD', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);
    vi.mocked(getActiveDomainRecords).mockResolvedValue([]);

    const result = await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' });

    expect(result.url).toBe('https://acme.pagespace.site/about');
  });

  it('home page response URL is the primary host root when a custom domain is active', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Home', content: '<div/>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'STANDARD', homePageId: 'page-1',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);
    vi.mocked(getActiveDomainRecords).mockResolvedValue([
      { hostname: 'www.acme.com', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);

    const result = await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' });

    expect(result.isHomePage).toBe(true);
    expect(result.url).toBe('https://www.acme.com/');
  });
});

describe('publishCanvasPage — SEO overrides', () => {
  // Capture the values passed to the published_pages upsert (path reservation)…
  let valuesSpy: ReturnType<typeof vi.fn>;
  // …and the payloads of every `db.update(...).set(...)` call. The SEO overrides
  // are committed in the POST-UPLOAD update (step 9), not the pre-upload upsert,
  // so a failed artifact write never persists metadata the artifact lacks.
  let updateSetCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue([]);
    vi.mocked(getActiveDomainRecords).mockResolvedValue([]);
    vi.mocked(extractAndStripOgMeta).mockReturnValue({
      meta: { faviconHref: undefined, ogImageUrl: undefined, ogDescription: undefined },
      html: '<div>hi</div>',
    });
    valuesSpy = vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }));
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);
    updateSetCalls = [];
    vi.mocked(db.update).mockReturnValue({
      set: (payload: Record<string, unknown>) => {
        updateSetCalls.push(payload);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    } as never);
  });

  // The SEO-bearing update is the one that also advances updatedAt (step 9).
  const seoUpdate = () => updateSetCalls.find((p) => 'updatedAt' in p && 'noindex' in p);

  const setupPage = (driveOverrides: Record<string, unknown> = {}) => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Page Title', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'STANDARD', homePageId: null, publishDefaultOgImageUrl: null, ...driveOverrides,
    }));
  };

  it('persists the author overrides only after the artifact upload (post-upload update)', async () => {
    setupPage();
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1',
      title: 'Custom Title', description: 'Custom desc', ogImageUrl: 'https://img.example/og.png', noindex: true,
    });

    // The reservation upsert never carries SEO columns…
    expect(valuesSpy).not.toHaveBeenCalledWith(expect.objectContaining({ publishTitle: 'Custom Title' }));
    // …the post-upload commit does.
    expect(seoUpdate()).toMatchObject({
      publishTitle: 'Custom Title',
      publishDescription: 'Custom desc',
      publishOgImageUrl: 'https://img.example/og.png',
      noindex: true,
    });
  });

  it('does not persist SEO metadata when the artifact upload fails', async () => {
    setupPage();
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);
    vi.mocked(putPublishedArtifact).mockRejectedValueOnce(new Error('S3 down'));

    await expect(publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', title: 'Custom Title', noindex: true,
    })).rejects.toThrow('S3 down');

    // Upload failed before step 9, so no SEO-bearing update ran.
    expect(seoUpdate()).toBeUndefined();
  });

  it('threads the title override and noindex into the rendered page', async () => {
    setupPage();
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1',
      title: 'Custom Title', noindex: true,
    });

    const renderInput = vi.mocked(renderPublishedPage).mock.lastCall?.[0];
    expect(renderInput?.title).toBe('Custom Title');
    expect(renderInput?.robots).toBe('noindex');
  });

  it('falls back to the drive default OG image when neither override nor canvas set one', async () => {
    setupPage({ publishDefaultOgImageUrl: 'https://drive-default.example/og.png' });
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' });

    const renderInput = vi.mocked(renderPublishedPage).mock.lastCall?.[0];
    expect(renderInput?.ogImageUrl).toBe('https://drive-default.example/og.png');
  });

  it('prefers an explicit override image over the drive default', async () => {
    setupPage({ publishDefaultOgImageUrl: 'https://drive-default.example/og.png' });
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    await publishCanvasPage({
      pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', ogImageUrl: 'https://override.example/og.png',
    });

    const renderInput = vi.mocked(renderPublishedPage).mock.lastCall?.[0];
    expect(renderInput?.ogImageUrl).toBe('https://override.example/og.png');
  });

  it('preserves persisted overrides when a republish passes no override fields', async () => {
    setupPage();
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(publishedPageRow({
      artifactKey: 'published/acme/page/index.html',
      publishTitle: 'Sticky Title',
      publishDescription: 'Sticky desc',
      publishOgImageUrl: 'https://sticky.example/og.png',
      noindex: true,
    }));

    await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' });

    expect(seoUpdate()).toMatchObject({
      publishTitle: 'Sticky Title',
      publishDescription: 'Sticky desc',
      publishOgImageUrl: 'https://sticky.example/og.png',
      noindex: true,
    });
    const renderInput = vi.mocked(renderPublishedPage).mock.lastCall?.[0];
    expect(renderInput?.title).toBe('Sticky Title');
    expect(renderInput?.robots).toBe('noindex');
  });

  it('clears a persisted override when an empty string is passed', async () => {
    setupPage();
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(publishedPageRow({
      artifactKey: 'published/acme/page/index.html',
      publishTitle: 'Old Title',
      publishDescription: null,
      publishOgImageUrl: null,
      noindex: false,
    }));

    await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1', title: '' });

    expect(seoUpdate()).toMatchObject({ publishTitle: null });
    // Title falls back to the live page title once the override is cleared.
    const renderInput = vi.mocked(renderPublishedPage).mock.lastCall?.[0];
    expect(renderInput?.title).toBe('Page Title');
  });
});

describe('publishHomePageAtRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
    vi.mocked(getActiveDomainRecords).mockResolvedValue([]);
  });

  it('returns null when the drive has no home page', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({ id: 'drive-1', homePageId: null }));

    const result = await publishHomePageAtRoot('drive-1', 'user-1');
    expect(result).toBeNull();
  });

  it('publishes the drive home page (root mirror) and returns the root url', async () => {
    vi.mocked(db.query.drives.findFirst)
      // First call: resolve homePageId in publishHomePageAtRoot
      .mockResolvedValueOnce(driveRow({ id: 'drive-1', homePageId: 'page-1' }))
      // Second call: drive load inside publishCanvasPage
      .mockResolvedValueOnce(driveRow({
        id: 'drive-1', slug: 'my-drive', publishSubdomain: 'sub', kind: 'STANDARD', homePageId: 'page-1',
      }));
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Home', content: '<div>home</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    const result = await publishHomePageAtRoot('drive-1', 'user-1');

    expect(result).not.toBeNull();
    expect(result!.isHomePage).toBe(true);
    expect(result!.url).toBe('https://sub.pagespace.site/');
    expect(putPublishedArtifact).toHaveBeenCalledWith({ subdomain: 'sub', path: '', html: expect.any(String) });
  });

  it('propagates a PublishError when the home page is not a canvas', async () => {
    vi.mocked(db.query.drives.findFirst)
      .mockResolvedValueOnce(driveRow({ id: 'drive-1', homePageId: 'page-1' }))
      .mockResolvedValueOnce(driveRow({
        id: 'drive-1', slug: 'my-drive', publishSubdomain: 'sub', kind: 'STANDARD', homePageId: 'page-1',
      }));
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'DOCUMENT', title: 'Doc', content: '', driveId: 'drive-1',
    }));

    await expect(publishHomePageAtRoot('drive-1', 'user-1')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('clearPublishedHomeRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
    vi.mocked(getActiveDomainRecords).mockResolvedValue([]);
  });

  it('deletes the root mirror artifact for the drive subdomain', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({ publishSubdomain: 'sub' }));

    await clearPublishedHomeRoot('drive-1');

    expect(deletePublishedArtifact).toHaveBeenCalledWith('published/sub/index.html');
  });

  it('is a no-op when the drive has no subdomain', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({ publishSubdomain: null }));

    await clearPublishedHomeRoot('drive-1');

    expect(deletePublishedArtifact).not.toHaveBeenCalled();
  });

  it('is a no-op when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);

    await clearPublishedHomeRoot('drive-1');

    expect(deletePublishedArtifact).not.toHaveBeenCalled();
  });

  it('rethrows when the root-mirror delete fails (unpublish must not silently succeed)', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({ publishSubdomain: 'sub' }));
    vi.mocked(deletePublishedArtifact).mockRejectedValueOnce(new Error('S3 down'));

    await expect(clearPublishedHomeRoot('drive-1')).rejects.toThrow('S3 down');
  });
});

// The mocked relational query keeps its real return types; published_pages rows
// are cast through `unknown` to the partial-column shape (never `any`).
type PublishedRow = Awaited<ReturnType<typeof db.query.publishedPages.findMany>>[number];
const publishedRows = (rows: Record<string, unknown>[]) => rows as unknown as PublishedRow[];

describe('publishCanvasPage site-file regeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([]));
  });

  it('writes robots.txt, sitemap.xml, and 404.html after a successful publish', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow({
      id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<div>hi</div>', driveId: 'drive-1',
    }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', name: 'My Drive', slug: 'my-drive', publishSubdomain: 'my-drive', kind: 'STANDARD', homePageId: 'page-1',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    await publishCanvasPage({ pageId: 'page-1', driveId: 'drive-1', userId: 'user-1' });

    const files = vi.mocked(putPublishedSiteFile).mock.calls.map((c) => c[0].file).sort();
    expect(files).toEqual(['404.html', 'robots.txt', 'sitemap.xml']);
    expect(putPublishedSiteFile).toHaveBeenCalledWith(
      expect.objectContaining({ subdomain: 'my-drive', file: 'robots.txt' }),
    );
  });
});

describe('regeneratePublishedSiteFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([]));
    vi.mocked(publishedArtifactExists).mockResolvedValue(true);
    vi.mocked(getActiveDomainRecords).mockResolvedValue([]);
  });

  it('uses the active custom domain as origin for sitemap/robots URLs', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      name: 'Acme', publishSubdomain: 'acme', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'p1', path: 'about', updatedAt: new Date('2026-06-22T00:00:00.000Z') },
    ]));
    vi.mocked(getActiveDomainRecords).mockResolvedValue([
      { hostname: 'www.acme.com', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);

    await regeneratePublishedSiteFiles('drive-1');

    const sitemapCall = vi.mocked(putPublishedSiteFile).mock.calls.find((c) => c[0].file === 'sitemap.xml');
    // Sitemap <loc> uses the custom domain, not the subdomain
    expect(sitemapCall?.[0].body).toContain('https://www.acme.com/about');
    expect(sitemapCall?.[0].body).not.toContain('pagespace.site');

    const robotsCall = vi.mocked(putPublishedSiteFile).mock.calls.find((c) => c[0].file === 'robots.txt');
    expect(robotsCall?.[0].body).toContain('https://www.acme.com/sitemap.xml');
  });

  it('falls back to subdomain origin when no active custom domain', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      name: 'Acme', publishSubdomain: 'acme', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'p1', path: 'about', updatedAt: new Date('2026-06-22T00:00:00.000Z') },
    ]));
    vi.mocked(getActiveDomainRecords).mockResolvedValue([]);

    await regeneratePublishedSiteFiles('drive-1');

    const sitemapCall = vi.mocked(putPublishedSiteFile).mock.calls.find((c) => c[0].file === 'sitemap.xml');
    expect(sitemapCall?.[0].body).toContain('https://acme.pagespace.site/about');
  });

  it('canonicalizes the home page to root when its root mirror exists', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      name: 'Acme', publishSubdomain: 'acme', homePageId: 'home-page',
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'home-page', path: 'welcome', updatedAt: new Date('2026-06-22T00:00:00.000Z') },
      { pageId: 'about-page', path: 'about', updatedAt: new Date('2026-06-21T00:00:00.000Z') },
    ]));
    vi.mocked(publishedArtifactExists).mockResolvedValue(true);

    await regeneratePublishedSiteFiles('drive-1');

    // The sitemap stub joins each route's loc; the home page resolves to the
    // root, the other page to its slug.
    const sitemapCall = vi.mocked(putPublishedSiteFile).mock.calls.find((c) => c[0].file === 'sitemap.xml');
    expect(sitemapCall?.[0].body).toContain('https://acme.pagespace.site/');
    expect(sitemapCall?.[0].body).toContain('https://acme.pagespace.site/about');
    expect(sitemapCall?.[0].body).not.toContain('/welcome');
  });

  it('keeps the home page slug URL when no root mirror exists (homePageId set as metadata only)', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      name: 'Acme', publishSubdomain: 'acme', homePageId: 'home-page',
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'home-page', path: 'welcome', updatedAt: new Date('2026-06-22T00:00:00.000Z') },
    ]));
    // The page was published at its slug, then set as home page without being
    // re-published — so published/<sub>/index.html does NOT exist.
    vi.mocked(publishedArtifactExists).mockResolvedValue(false);

    await regeneratePublishedSiteFiles('drive-1');

    const sitemapCall = vi.mocked(putPublishedSiteFile).mock.calls.find((c) => c[0].file === 'sitemap.xml');
    // The live slug URL is advertised; the (nonexistent) root is NOT.
    expect(sitemapCall?.[0].body).toContain('https://acme.pagespace.site/welcome');
    expect(sitemapCall?.[0].body).not.toMatch(/acme\.pagespace\.site\/(?!welcome)/);
  });

  it('does not probe storage for the root mirror when the drive has no home page', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      name: 'Acme', publishSubdomain: 'acme', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'about-page', path: 'about', updatedAt: new Date('2026-06-21T00:00:00.000Z') },
    ]));

    await regeneratePublishedSiteFiles('drive-1');

    expect(publishedArtifactExists).not.toHaveBeenCalled();
  });

  it('excludes noindex pages from the sitemap', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      name: 'Acme', publishSubdomain: 'acme', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'p1', path: 'public', updatedAt: new Date('2026-06-22T00:00:00.000Z'), noindex: false },
      { pageId: 'p2', path: 'secret', updatedAt: new Date('2026-06-21T00:00:00.000Z'), noindex: true },
    ]));

    await regeneratePublishedSiteFiles('drive-1');

    const sitemapCall = vi.mocked(putPublishedSiteFile).mock.calls.find((c) => c[0].file === 'sitemap.xml');
    expect(sitemapCall?.[0].body).toContain('https://acme.pagespace.site/public');
    expect(sitemapCall?.[0].body).not.toContain('/secret');
  });

  it('regenerates the sitemap even with zero published pages (unpublish to empty)', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      name: 'Acme', publishSubdomain: 'acme', homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([]));

    await regeneratePublishedSiteFiles('drive-1');

    expect(putPublishedSiteFile).toHaveBeenCalledTimes(3);
  });

  it('is a no-op when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);

    await regeneratePublishedSiteFiles('drive-1');

    expect(putPublishedSiteFile).not.toHaveBeenCalled();
  });

  it('is a no-op when the drive has no subdomain', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      name: 'Acme', publishSubdomain: null, homePageId: null,
    }));

    await regeneratePublishedSiteFiles('drive-1');

    expect(putPublishedSiteFile).not.toHaveBeenCalled();
  });

  it('swallows storage failures so a publish/unpublish is never rolled back by a site-file write', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      name: 'Acme', publishSubdomain: 'acme', homePageId: null,
    }));
    vi.mocked(putPublishedSiteFile).mockRejectedValue(new Error('S3 down'));

    await expect(regeneratePublishedSiteFiles('drive-1')).resolves.toBeUndefined();
  });
});

// Published-page row cast helper (parallel to the PageRow helper above).
type PublishedPageRow = NonNullable<Awaited<ReturnType<typeof db.query.publishedPages.findFirst>>>;
const publishedPageRow = (row: Record<string, unknown>) => row as unknown as PublishedPageRow;

describe('syncPublishedHomeRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue([]);
    vi.mocked(getActiveDomainRecords).mockResolvedValue([]);
  });

  it('is a no-op when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);

    await syncPublishedHomeRoot('drive-1');

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    expect(deletePublishedArtifact).not.toHaveBeenCalled();
  });

  it('is a no-op when the drive has no publishSubdomain', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: null, homePageId: 'page-1',
    }));

    await syncPublishedHomeRoot('drive-1');

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    expect(deletePublishedArtifact).not.toHaveBeenCalled();
  });

  it('deletes the root and regenerates site files when homePageId is cleared (null)', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'sub', homePageId: null,
    }));

    await syncPublishedHomeRoot('drive-1');

    expect(deletePublishedArtifact).toHaveBeenCalledWith('published/sub/index.html');
    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    // Sitemap must no longer advertise the dead `/` route.
    expect(putPublishedSiteFile).toHaveBeenCalled();
  });

  it('copies the slug artifact to the root when the home page is published', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'sub', homePageId: 'page-1',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(publishedPageRow({
      artifactKey: 'published/sub/home/index.html',
    }));

    await syncPublishedHomeRoot('drive-1');

    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/sub/home/index.html',
      'published/sub/index.html',
    );
    // Site files regenerated so the sitemap lists `/`.
    expect(putPublishedSiteFile).toHaveBeenCalled();
  });

  it('deletes the root and regenerates site files when the home page is not yet published (unpublished stays private)', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'sub', homePageId: 'page-1',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined);

    await syncPublishedHomeRoot('drive-1');

    expect(deletePublishedArtifact).toHaveBeenCalledWith('published/sub/index.html');
    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    // Sitemap must no longer advertise the dead `/` route.
    expect(putPublishedSiteFile).toHaveBeenCalled();
  });

  it('is idempotent: re-marking the same published home page re-copies without error', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'sub', homePageId: 'page-1',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(publishedPageRow({
      artifactKey: 'published/sub/home/index.html',
    }));

    await syncPublishedHomeRoot('drive-1');
    await syncPublishedHomeRoot('drive-1');

    expect(copyPublishedArtifact).toHaveBeenCalledTimes(2);
  });

  it('swallows errors so the metadata update is never blocked', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'sub', homePageId: 'page-1',
    }));
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(publishedPageRow({
      artifactKey: 'published/sub/home/index.html',
    }));
    vi.mocked(copyPublishedArtifact).mockRejectedValueOnce(new Error('S3 down'));

    await expect(syncPublishedHomeRoot('drive-1')).resolves.toBeUndefined();
  });
});

describe('republishDriveCanonical', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
  });

  it('re-renders every published page at its existing path and returns the count', async () => {
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue([
      { pageId: 'page-1', path: 'about' },
      { pageId: 'page-2', path: 'team/leadership' },
    ] as unknown as Awaited<ReturnType<typeof db.query.publishedPages.findMany>>);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(
      pageRow({ id: 'page-x', type: 'CANVAS', title: 'Ignored Title', content: '<div/>', driveId: 'drive-1' }),
    );
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'STANDARD', homePageId: null,
    }));

    const count = await republishDriveCanonical('drive-1', 'user-1');

    expect(count).toBe(2);
    // Each page is re-published at its STORED path, not re-derived from the title.
    const paths = vi.mocked(putPublishedArtifact).mock.calls.map(([arg]) => (arg as { path: string }).path);
    expect(paths).toContain('about');
    expect(paths).toContain('team/leadership');
  });

  it('isolates per-page failures and counts only the successes', async () => {
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue([
      { pageId: 'missing', path: 'gone' },
      { pageId: 'page-2', path: 'ok' },
    ] as unknown as Awaited<ReturnType<typeof db.query.publishedPages.findMany>>);
    // First page is missing → publishCanvasPage throws; second succeeds.
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce(undefined as unknown as PageRow)
      .mockResolvedValue(pageRow({ id: 'page-2', type: 'CANVAS', title: 'OK', content: '<div/>', driveId: 'drive-1' }));
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'STANDARD', homePageId: null,
    }));

    const count = await republishDriveCanonical('drive-1', 'user-1');

    expect(count).toBe(1);
  });

  it('is a no-op returning 0 when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);
    const count = await republishDriveCanonical('drive-1', 'user-1');
    expect(count).toBe(0);
    expect(db.query.publishedPages.findMany).not.toHaveBeenCalled();
  });
});
