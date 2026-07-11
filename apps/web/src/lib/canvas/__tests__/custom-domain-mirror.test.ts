import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
    query: {
      drives: { findFirst: vi.fn() },
      publishedPages: { findMany: vi.fn().mockResolvedValue([]) },
      customDomains: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn() }));

vi.mock('@pagespace/db/schema/custom-domains', () => ({
  customDomains: {
    driveId: 'customDomains.driveId',
    hostname: 'customDomains.hostname',
    status: 'customDomains.status',
    createdAt: 'customDomains.createdAt',
    isPrimary: 'customDomains.isPrimary',
    platformOwned: 'customDomains.platformOwned',
    publishLandingPageId: 'customDomains.publishLandingPageId',
    publishNotFoundPageId: 'customDomains.publishNotFoundPageId',
  },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id' },
}));

vi.mock('@pagespace/db/schema/published-pages', () => ({
  publishedPages: { driveId: 'publishedPages.driveId' },
}));

vi.mock('../published-storage', () => ({
  buildPublishedKey: vi.fn((prefix: string, path: string) =>
    path ? `published/${prefix}/${path}/index.html` : `published/${prefix}/index.html`,
  ),
  copyPublishedArtifact: vi.fn().mockResolvedValue(undefined),
  copyPublishedSiteFileArtifact: vi.fn().mockResolvedValue(undefined),
  deletePublishedArtifact: vi.fn().mockResolvedValue(undefined),
  clearPublishedPrefix: vi.fn().mockResolvedValue(undefined),
  publishedArtifactExists: vi.fn().mockResolvedValue(false),
  isPublishConfigured: vi.fn().mockReturnValue(true),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { warn: vi.fn(), error: vi.fn() } },
}));

import { db } from '@pagespace/db/db';
import {
  copyPublishedArtifact,
  copyPublishedSiteFileArtifact,
  deletePublishedArtifact,
  clearPublishedPrefix,
  publishedArtifactExists,
  isPublishConfigured,
} from '../published-storage';
import {
  mirrorPublishedPageToHosts,
  mirror404ToHosts,
  deletePageFromCustomHosts,
  mirrorDriveToCustomHost,
  clearCustomHost,
  getActiveDomainRecords,
} from '../custom-domain-mirror';

// Cast helpers (same approach as publish-page.test.ts)
type DriveRow = NonNullable<Awaited<ReturnType<typeof db.query.drives.findFirst>>>;
const driveRow = (row: Record<string, unknown>) => row as unknown as DriveRow;
type PublishedRow = Awaited<ReturnType<typeof db.query.publishedPages.findMany>>[number];
const publishedRows = (rows: Record<string, unknown>[]) => rows as unknown as PublishedRow[];

/** Build a mock db.select() chain that returns `rows`. */
function mockSelect(rows: Record<string, unknown>[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

/** Shared override-404 renderer, defaulting to a successful render. */
const renderOverride404 = vi.fn().mockResolvedValue(true);

describe('mirrorPublishedPageToHosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
  });

  it('copies slug artifact to each active host', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active', publishLandingPageId: null }]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'about',
      pageId: 'p1',
      homePageId: null,
    });

    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/acme/about/index.html',
      'published/a.example.com/about/index.html',
    );
    expect(copyPublishedArtifact).toHaveBeenCalledTimes(1);
  });

  it('also copies root mirror when the publish IS the drive home page', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active', publishLandingPageId: null }]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'home',
      pageId: 'p1',
      homePageId: 'p1',
    });

    expect(copyPublishedArtifact).toHaveBeenCalledTimes(2);
    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/acme/home/index.html',
      'published/a.example.com/home/index.html',
    );
    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/acme/home/index.html',
      'published/a.example.com/index.html',
    );
  });

  it('a host overridden to a DIFFERENT page does not get its root touched by the home-page publish', async () => {
    mockSelect([{ hostname: 'docs.example.com', status: 'active', publishLandingPageId: 'p-docs' }]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'home',
      pageId: 'p1',
      homePageId: 'p1',
    });

    // Path copy still happens; root copy is skipped since this host's override targets p-docs, not p1.
    expect(copyPublishedArtifact).toHaveBeenCalledTimes(1);
    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/acme/home/index.html',
      'published/docs.example.com/home/index.html',
    );
  });

  it('a host overridden to THIS page gets its root updated even though this is not the drive home page', async () => {
    mockSelect([{ hostname: 'docs.example.com', status: 'active', publishLandingPageId: 'p-docs' }]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'docs',
      pageId: 'p-docs',
      homePageId: 'p1',
    });

    expect(copyPublishedArtifact).toHaveBeenCalledTimes(2);
    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/acme/docs/index.html',
      'published/docs.example.com/index.html',
    );
  });

  it('copies to all active hosts, not just the first', async () => {
    mockSelect([
      { hostname: 'a.example.com', status: 'active', publishLandingPageId: null },
      { hostname: 'b.example.com', status: 'active', publishLandingPageId: null },
    ]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'about',
      pageId: 'p1',
      homePageId: null,
    });

    expect(copyPublishedArtifact).toHaveBeenCalledTimes(2);
  });

  it('mirrors to serving (verified/provisioning/active) hosts but NOT pending/dns_failed', async () => {
    mockSelect([
      { hostname: 'pending.example.com', status: 'pending', publishLandingPageId: null },
      { hostname: 'verified.example.com', status: 'verified', publishLandingPageId: null },
      { hostname: 'provisioning.example.com', status: 'provisioning', publishLandingPageId: null },
      { hostname: 'active.example.com', status: 'active', publishLandingPageId: null },
      { hostname: 'dnsfailed.example.com', status: 'dns_failed', publishLandingPageId: null },
    ]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'about',
      pageId: 'p1',
      homePageId: null,
    });

    // verified + provisioning + active each receive a copy; pending/dns_failed do not.
    expect(copyPublishedArtifact).toHaveBeenCalledTimes(3);
    const targets = vi.mocked(copyPublishedArtifact).mock.calls.map(([, to]) => to);
    expect(targets).toEqual(
      expect.arrayContaining([
        'published/verified.example.com/about/index.html',
        'published/provisioning.example.com/about/index.html',
        'published/active.example.com/about/index.html',
      ]),
    );
    expect(targets).not.toContain('published/pending.example.com/about/index.html');
    expect(targets).not.toContain('published/dnsfailed.example.com/about/index.html');
  });

  it('is a no-op when there are no serving custom domains', async () => {
    mockSelect([
      { hostname: 'pending.example.com', status: 'pending', publishLandingPageId: null },
      { hostname: 'dnsfailed.example.com', status: 'dns_failed', publishLandingPageId: null },
    ]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'about',
      pageId: 'p1',
      homePageId: null,
    });

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
  });

  it('is a no-op when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'about',
      pageId: 'p1',
      homePageId: null,
    });

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
  });

  it('swallows copy failures (best-effort)', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active', publishLandingPageId: null }]);
    vi.mocked(copyPublishedArtifact).mockRejectedValueOnce(new Error('S3 down'));

    await expect(
      mirrorPublishedPageToHosts({
        driveId: 'drive-1',
        subdomain: 'acme',
        path: 'about',
        pageId: 'p1',
        homePageId: null,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('mirror404ToHosts', () => {
  const driveCtx = {
    homePageId: null,
    publishFaviconUrl: null,
    publishDefaultOgImageUrl: null,
    ownerId: 'owner-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
  });

  it('copies 404.html, robots.txt, and sitemap.xml to each active host with no override', async () => {
    mockSelect([
      { hostname: 'a.example.com', status: 'active', createdAt: new Date(), publishNotFoundPageId: null },
      { hostname: 'b.example.com', status: 'active', createdAt: new Date(), publishNotFoundPageId: null },
    ]);

    await mirror404ToHosts('drive-1', 'acme', driveCtx, renderOverride404);

    // 3 site files × 2 hosts = 6 — all use copyPublishedSiteFileArtifact (preserves content-type)
    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledTimes(6);
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/404.html',
      'published/a.example.com/404.html',
    );
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/robots.txt',
      'published/a.example.com/robots.txt',
    );
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/sitemap.xml',
      'published/a.example.com/sitemap.xml',
    );
    expect(renderOverride404).not.toHaveBeenCalled();
  });

  it('a host with publishNotFoundPageId gets its own rendered 404 instead of the drive-wide copy', async () => {
    mockSelect([
      { hostname: 'a.example.com', status: 'active', createdAt: new Date(), publishNotFoundPageId: null },
      { hostname: 'docs.example.com', status: 'active', createdAt: new Date(), publishNotFoundPageId: 'p-404' },
    ]);

    await mirror404ToHosts('drive-1', 'acme', driveCtx, renderOverride404);

    // Plain host: 404 + robots + sitemap via copy. Override host: robots + sitemap via
    // copy, 404 via renderOverride404 instead — never copyPublishedSiteFileArtifact for 404.
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/404.html',
      'published/a.example.com/404.html',
    );
    const to404 = vi.mocked(copyPublishedSiteFileArtifact).mock.calls.map(([, to]) => to);
    expect(to404).not.toContain('published/docs.example.com/404.html');
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/robots.txt',
      'published/docs.example.com/robots.txt',
    );
    expect(renderOverride404).toHaveBeenCalledWith(
      expect.objectContaining({ driveId: 'drive-1', host: 'docs.example.com', pageId: 'p-404' }),
    );
  });

  it('falls back to the drive-wide 404.html when the override render fails (e.g. its page was trashed)', async () => {
    mockSelect([{ hostname: 'docs.example.com', status: 'active', createdAt: new Date(), publishNotFoundPageId: 'p-404' }]);
    renderOverride404.mockResolvedValueOnce(false);

    await mirror404ToHosts('drive-1', 'acme', driveCtx, renderOverride404);

    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/404.html',
      'published/docs.example.com/404.html',
    );
  });

  it('falls back to the drive-wide 404.html when the override render throws', async () => {
    mockSelect([{ hostname: 'docs.example.com', status: 'active', createdAt: new Date(), publishNotFoundPageId: 'p-404' }]);
    renderOverride404.mockRejectedValueOnce(new Error('render boom'));

    await mirror404ToHosts('drive-1', 'acme', driveCtx, renderOverride404);

    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/404.html',
      'published/docs.example.com/404.html',
    );
  });

  it('is a no-op when no active hosts', async () => {
    mockSelect([]);

    await mirror404ToHosts('drive-1', 'acme', driveCtx, renderOverride404);

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    expect(copyPublishedSiteFileArtifact).not.toHaveBeenCalled();
  });

  it('is a no-op when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);

    await mirror404ToHosts('drive-1', 'acme', driveCtx, renderOverride404);

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    expect(copyPublishedSiteFileArtifact).not.toHaveBeenCalled();
  });

  it('swallows failures (best-effort)', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active', createdAt: new Date(), publishNotFoundPageId: null }]);
    vi.mocked(copyPublishedSiteFileArtifact).mockRejectedValueOnce(new Error('S3 down'));

    await expect(mirror404ToHosts('drive-1', 'acme', driveCtx, renderOverride404)).resolves.toBeUndefined();
  });
});

describe('deletePageFromCustomHosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
  });

  it('deletes slug artifact from each active host', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active', publishLandingPageId: null }]);

    await deletePageFromCustomHosts({ driveId: 'drive-1', pageId: 'p1', path: 'about', isHomePage: false });

    expect(deletePublishedArtifact).toHaveBeenCalledWith(
      'published/a.example.com/about/index.html',
    );
    expect(deletePublishedArtifact).toHaveBeenCalledTimes(1);
  });

  it('also deletes root mirror when isHomePage is true (no override)', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active', publishLandingPageId: null }]);

    await deletePageFromCustomHosts({ driveId: 'drive-1', pageId: 'p1', path: 'home', isHomePage: true });

    expect(deletePublishedArtifact).toHaveBeenCalledTimes(2);
    expect(deletePublishedArtifact).toHaveBeenCalledWith(
      'published/a.example.com/home/index.html',
    );
    expect(deletePublishedArtifact).toHaveBeenCalledWith(
      'published/a.example.com/index.html',
    );
  });

  it('also deletes root mirror when the deleted page is a host\'s own landing-page override, even if not the drive home page', async () => {
    mockSelect([{ hostname: 'docs.example.com', status: 'active', publishLandingPageId: 'p1' }]);

    await deletePageFromCustomHosts({ driveId: 'drive-1', pageId: 'p1', path: 'docs', isHomePage: false });

    expect(deletePublishedArtifact).toHaveBeenCalledTimes(2);
    expect(deletePublishedArtifact).toHaveBeenCalledWith(
      'published/docs.example.com/index.html',
    );
  });

  it('does NOT delete an overridden host\'s root when a different page (e.g. the drive home page) is deleted', async () => {
    mockSelect([{ hostname: 'docs.example.com', status: 'active', publishLandingPageId: 'p-docs' }]);

    await deletePageFromCustomHosts({ driveId: 'drive-1', pageId: 'p1', path: 'home', isHomePage: true });

    // Only the slug artifact is deleted — this host's root belongs to p-docs, not p1.
    expect(deletePublishedArtifact).toHaveBeenCalledTimes(1);
    expect(deletePublishedArtifact).toHaveBeenCalledWith(
      'published/docs.example.com/home/index.html',
    );
  });

  it('deletes from serving (verified/active) hosts but NOT pending/dns_failed', async () => {
    mockSelect([
      { hostname: 'pending.example.com', status: 'pending', publishLandingPageId: null },
      { hostname: 'verified.example.com', status: 'verified', publishLandingPageId: null },
      { hostname: 'active.example.com', status: 'active', publishLandingPageId: null },
      { hostname: 'dnsfailed.example.com', status: 'dns_failed', publishLandingPageId: null },
    ]);

    await deletePageFromCustomHosts({ driveId: 'drive-1', pageId: 'p1', path: 'about', isHomePage: false });

    expect(deletePublishedArtifact).toHaveBeenCalledTimes(2);
    const targets = vi.mocked(deletePublishedArtifact).mock.calls.map(([key]) => key);
    expect(targets).toEqual(
      expect.arrayContaining([
        'published/verified.example.com/about/index.html',
        'published/active.example.com/about/index.html',
      ]),
    );
    expect(targets).not.toContain('published/pending.example.com/about/index.html');
    expect(targets).not.toContain('published/dnsfailed.example.com/about/index.html');
  });

  it('is a no-op when no serving hosts', async () => {
    mockSelect([]);

    await deletePageFromCustomHosts({ driveId: 'drive-1', pageId: 'p1', path: 'about', isHomePage: false });

    expect(deletePublishedArtifact).not.toHaveBeenCalled();
  });

  it('is a no-op when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);

    await deletePageFromCustomHosts({ driveId: 'drive-1', pageId: 'p1', path: 'about', isHomePage: false });

    expect(deletePublishedArtifact).not.toHaveBeenCalled();
  });

  it('swallows delete failures (best-effort)', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active', publishLandingPageId: null }]);
    vi.mocked(deletePublishedArtifact).mockRejectedValueOnce(new Error('S3 down'));

    await expect(
      deletePageFromCustomHosts({ driveId: 'drive-1', pageId: 'p1', path: 'about', isHomePage: false }),
    ).resolves.toBeUndefined();
  });
});

describe('mirrorDriveToCustomHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
    vi.mocked(publishedArtifactExists).mockResolvedValue(false);
    // vi.clearAllMocks() resets call history but NOT a previous test's
    // mockResolvedValue — reset this to the "no domain-level override" default
    // every test so one test's override configuration can never leak into the
    // next (mockResolvedValue, unlike mockClear, persists across clearAllMocks).
    vi.mocked(db.query.customDomains.findFirst).mockResolvedValue(undefined);
  });

  it('copies every published page + 404.html + robots.txt + sitemap.xml to the host', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'acme',
      homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'p1', path: 'about' },
      { pageId: 'p2', path: 'team' },
    ]));

    await mirrorDriveToCustomHost('drive-1', 'www.example.com');

    // Page artifacts use copyPublishedArtifact (html content-type); site files use
    // copyPublishedSiteFileArtifact (MetadataDirective=COPY to preserve their content-type).
    expect(copyPublishedArtifact).toHaveBeenCalledTimes(2);
    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/acme/about/index.html',
      'published/www.example.com/about/index.html',
    );
    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/acme/team/index.html',
      'published/www.example.com/team/index.html',
    );
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledTimes(3);
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/404.html',
      'published/www.example.com/404.html',
    );
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/robots.txt',
      'published/www.example.com/robots.txt',
    );
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/sitemap.xml',
      'published/www.example.com/sitemap.xml',
    );
  });

  it('includes the root mirror when the home page is published and its root exists', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'acme',
      homePageId: 'p1',
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'p1', path: 'home' },
    ]));
    vi.mocked(publishedArtifactExists).mockResolvedValue(true);

    await mirrorDriveToCustomHost('drive-1', 'www.example.com');

    // 1 page + root = 2 page artifact copies; 3 site files via copyPublishedSiteFileArtifact
    expect(copyPublishedArtifact).toHaveBeenCalledTimes(2);
    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/acme/index.html',
      'published/www.example.com/index.html',
    );
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledTimes(3);
  });

  it('does NOT include root when home page exists but root mirror does not', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'acme',
      homePageId: 'p1',
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'p1', path: 'home' },
    ]));
    vi.mocked(publishedArtifactExists).mockResolvedValue(false);

    await mirrorDriveToCustomHost('drive-1', 'www.example.com');

    // 1 page (no root) via copyPublishedArtifact; 3 site files via copyPublishedSiteFileArtifact
    expect(copyPublishedArtifact).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(copyPublishedArtifact).mock.calls.map(([, to]) => to);
    expect(calls).not.toContain('published/www.example.com/index.html');
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledTimes(3);
  });

  it('clears a stale root object when no root copy resolves (e.g. an override was reset)', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'acme',
      homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'p1', path: 'about' },
    ]));

    await mirrorDriveToCustomHost('drive-1', 'www.example.com');

    expect(deletePublishedArtifact).toHaveBeenCalledWith('published/www.example.com/index.html');
  });

  it('does NOT clear the root when the home-root existence probe fails (transient error, not confirmed absence)', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'acme',
      homePageId: 'p1',
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'p1', path: 'home' },
    ]));
    vi.mocked(publishedArtifactExists).mockRejectedValue(new Error('S3 timeout'));

    await mirrorDriveToCustomHost('drive-1', 'www.example.com');

    expect(deletePublishedArtifact).not.toHaveBeenCalledWith('published/www.example.com/index.html');
  });

  it('clears a stale root object when an override is set but its target page is not yet published', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'acme',
      homePageId: null,
    }));
    vi.mocked(db.query.customDomains.findFirst).mockResolvedValue({
      publishLandingPageId: 'p-not-published-yet',
      publishNotFoundPageId: null,
    } as never);
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'p1', path: 'about' },
    ]));

    await mirrorDriveToCustomHost('drive-1', 'www.example.com');

    expect(deletePublishedArtifact).toHaveBeenCalledWith('published/www.example.com/index.html');
  });

  it('does NOT clear the root object when a root copy successfully resolves', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'acme',
      homePageId: 'p1',
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'p1', path: 'home' },
    ]));
    vi.mocked(publishedArtifactExists).mockResolvedValue(true);

    await mirrorDriveToCustomHost('drive-1', 'www.example.com');

    expect(deletePublishedArtifact).not.toHaveBeenCalledWith('published/www.example.com/index.html');
  });

  it('copies only site files (404.html + robots.txt + sitemap.xml) when the drive has no published pages', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'acme',
      homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([]));

    await mirrorDriveToCustomHost('drive-1', 'www.example.com');

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledTimes(3);
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/404.html',
      'published/www.example.com/404.html',
    );
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/robots.txt',
      'published/www.example.com/robots.txt',
    );
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/sitemap.xml',
      'published/www.example.com/sitemap.xml',
    );
  });

  it('is a no-op when the drive has no publish subdomain', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: null,
      homePageId: null,
    }));

    await mirrorDriveToCustomHost('drive-1', 'www.example.com');

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    expect(copyPublishedSiteFileArtifact).not.toHaveBeenCalled();
  });

  it('is a no-op when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);

    await mirrorDriveToCustomHost('drive-1', 'www.example.com');

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    expect(copyPublishedSiteFileArtifact).not.toHaveBeenCalled();
  });

  it('swallows per-copy failures and continues the backfill', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'acme',
      homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([
      { pageId: 'p1', path: 'about' },
      { pageId: 'p2', path: 'team' },
    ]));
    // First page-artifact copy fails, rest succeed
    vi.mocked(copyPublishedArtifact).mockRejectedValueOnce(new Error('S3 error'));

    await expect(mirrorDriveToCustomHost('drive-1', 'www.example.com')).resolves.toBeUndefined();
    // Despite the failure, remaining page copies and all site file copies were still attempted
    expect(copyPublishedArtifact).toHaveBeenCalledTimes(2); // 2 page artifacts
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledTimes(3); // 3 site files
  });

  it('skips the drive-wide 404.html copy when the host has a working publishNotFoundPageId override', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'acme',
      homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([]));
    vi.mocked(db.query.customDomains.findFirst).mockResolvedValue({
      publishLandingPageId: null,
      publishNotFoundPageId: 'p-404',
    } as never);
    const renderOverride404 = vi.fn().mockResolvedValue(true);

    await mirrorDriveToCustomHost('drive-1', 'www.example.com', renderOverride404);

    expect(renderOverride404).toHaveBeenCalledWith(expect.objectContaining({ pageId: 'p-404' }));
    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledTimes(2); // robots + sitemap, NOT 404
    const to404 = vi.mocked(copyPublishedSiteFileArtifact).mock.calls.map(([, to]) => to);
    expect(to404).not.toContain('published/www.example.com/404.html');
  });

  it('falls back to the drive-wide 404.html when the publishNotFoundPageId override fails to render', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRow({
      publishSubdomain: 'acme',
      homePageId: null,
    }));
    vi.mocked(db.query.publishedPages.findMany).mockResolvedValue(publishedRows([]));
    vi.mocked(db.query.customDomains.findFirst).mockResolvedValue({
      publishLandingPageId: null,
      publishNotFoundPageId: 'p-404',
    } as never);
    const renderOverride404 = vi.fn().mockResolvedValue(false);

    await mirrorDriveToCustomHost('drive-1', 'www.example.com', renderOverride404);

    expect(copyPublishedSiteFileArtifact).toHaveBeenCalledWith(
      'published/acme/404.html',
      'published/www.example.com/404.html',
    );
  });
});

describe('getActiveDomainRecords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
  });

  it('returns hostname and createdAt for active domains only', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    mockSelect([
      { hostname: 'active.example.com', status: 'active', createdAt },
      { hostname: 'pending.example.com', status: 'pending', createdAt },
    ]);

    const records = await getActiveDomainRecords('drive-1');

    expect(records).toHaveLength(1);
    expect(records[0].hostname).toBe('active.example.com');
    expect(records[0].createdAt).toEqual(createdAt);
  });

  it('returns empty array when no active domains', async () => {
    mockSelect([{ hostname: 'pending.example.com', status: 'pending', createdAt: new Date() }]);

    const records = await getActiveDomainRecords('drive-1');

    expect(records).toHaveLength(0);
  });

  it('excludes platformOwned rows even when active, so they never win primary-host selection', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    mockSelect([
      { hostname: 'pagespace.ai', status: 'active', createdAt, platformOwned: true },
      { hostname: 'custom.example.com', status: 'active', createdAt, platformOwned: false },
    ]);

    const records = await getActiveDomainRecords('drive-1');

    expect(records).toHaveLength(1);
    expect(records[0].hostname).toBe('custom.example.com');
  });

  it('is a no-op array when the only active domain is platformOwned', async () => {
    mockSelect([{ hostname: 'pagespace.ai', status: 'active', createdAt: new Date(), platformOwned: true }]);

    const records = await getActiveDomainRecords('drive-1');

    expect(records).toHaveLength(0);
  });
});

describe('clearCustomHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
  });

  it('clears the host prefix in the publish bucket', async () => {
    await clearCustomHost('www.example.com');

    expect(clearPublishedPrefix).toHaveBeenCalledWith('www.example.com');
  });

  it('is a no-op when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);

    await clearCustomHost('www.example.com');

    expect(clearPublishedPrefix).not.toHaveBeenCalled();
  });

  it('propagates storage errors (caller must handle)', async () => {
    vi.mocked(clearPublishedPrefix).mockRejectedValueOnce(new Error('S3 down'));

    await expect(clearCustomHost('www.example.com')).rejects.toThrow('S3 down');
  });
});
