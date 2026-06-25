import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
    query: {
      drives: { findFirst: vi.fn() },
      publishedPages: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));

vi.mock('@pagespace/db/schema/custom-domains', () => ({
  customDomains: { driveId: 'customDomains.driveId', hostname: 'customDomains.hostname', status: 'customDomains.status', createdAt: 'customDomains.createdAt' },
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

describe('mirrorPublishedPageToHosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
  });

  it('copies slug artifact to each active host', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active' }]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'about',
      isHomePage: false,
    });

    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/acme/about/index.html',
      'published/a.example.com/about/index.html',
    );
    expect(copyPublishedArtifact).toHaveBeenCalledTimes(1);
  });

  it('also copies root mirror when isHomePage is true', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active' }]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'home',
      isHomePage: true,
    });

    expect(copyPublishedArtifact).toHaveBeenCalledTimes(2);
    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/acme/home/index.html',
      'published/a.example.com/home/index.html',
    );
    expect(copyPublishedArtifact).toHaveBeenCalledWith(
      'published/acme/index.html',
      'published/a.example.com/index.html',
    );
  });

  it('copies to all active hosts, not just the first', async () => {
    mockSelect([
      { hostname: 'a.example.com', status: 'active' },
      { hostname: 'b.example.com', status: 'active' },
    ]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'about',
      isHomePage: false,
    });

    expect(copyPublishedArtifact).toHaveBeenCalledTimes(2);
  });

  it('mirrors to serving (verified/provisioning/active) hosts but NOT pending/dns_failed', async () => {
    mockSelect([
      { hostname: 'pending.example.com', status: 'pending' },
      { hostname: 'verified.example.com', status: 'verified' },
      { hostname: 'provisioning.example.com', status: 'provisioning' },
      { hostname: 'active.example.com', status: 'active' },
      { hostname: 'dnsfailed.example.com', status: 'dns_failed' },
    ]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'about',
      isHomePage: false,
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
      { hostname: 'pending.example.com', status: 'pending' },
      { hostname: 'dnsfailed.example.com', status: 'dns_failed' },
    ]);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'about',
      isHomePage: false,
    });

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
  });

  it('is a no-op when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);

    await mirrorPublishedPageToHosts({
      driveId: 'drive-1',
      subdomain: 'acme',
      path: 'about',
      isHomePage: false,
    });

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
  });

  it('swallows copy failures (best-effort)', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active' }]);
    vi.mocked(copyPublishedArtifact).mockRejectedValueOnce(new Error('S3 down'));

    await expect(
      mirrorPublishedPageToHosts({
        driveId: 'drive-1',
        subdomain: 'acme',
        path: 'about',
        isHomePage: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('mirror404ToHosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
  });

  it('copies 404.html, robots.txt, and sitemap.xml to each active host', async () => {
    mockSelect([
      { hostname: 'a.example.com', status: 'active', createdAt: new Date() },
      { hostname: 'b.example.com', status: 'active', createdAt: new Date() },
    ]);

    await mirror404ToHosts('drive-1', 'acme');

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
  });

  it('is a no-op when no active hosts', async () => {
    mockSelect([]);

    await mirror404ToHosts('drive-1', 'acme');

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    expect(copyPublishedSiteFileArtifact).not.toHaveBeenCalled();
  });

  it('is a no-op when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);

    await mirror404ToHosts('drive-1', 'acme');

    expect(copyPublishedArtifact).not.toHaveBeenCalled();
    expect(copyPublishedSiteFileArtifact).not.toHaveBeenCalled();
  });

  it('swallows failures (best-effort)', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active', createdAt: new Date() }]);
    vi.mocked(copyPublishedSiteFileArtifact).mockRejectedValueOnce(new Error('S3 down'));

    await expect(mirror404ToHosts('drive-1', 'acme')).resolves.toBeUndefined();
  });
});

describe('deletePageFromCustomHosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
  });

  it('deletes slug artifact from each active host', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active' }]);

    await deletePageFromCustomHosts({ driveId: 'drive-1', path: 'about', isHomePage: false });

    expect(deletePublishedArtifact).toHaveBeenCalledWith(
      'published/a.example.com/about/index.html',
    );
    expect(deletePublishedArtifact).toHaveBeenCalledTimes(1);
  });

  it('also deletes root mirror when isHomePage is true', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active' }]);

    await deletePageFromCustomHosts({ driveId: 'drive-1', path: 'home', isHomePage: true });

    expect(deletePublishedArtifact).toHaveBeenCalledTimes(2);
    expect(deletePublishedArtifact).toHaveBeenCalledWith(
      'published/a.example.com/home/index.html',
    );
    expect(deletePublishedArtifact).toHaveBeenCalledWith(
      'published/a.example.com/index.html',
    );
  });

  it('deletes from serving (verified/active) hosts but NOT pending/dns_failed', async () => {
    mockSelect([
      { hostname: 'pending.example.com', status: 'pending' },
      { hostname: 'verified.example.com', status: 'verified' },
      { hostname: 'active.example.com', status: 'active' },
      { hostname: 'dnsfailed.example.com', status: 'dns_failed' },
    ]);

    await deletePageFromCustomHosts({ driveId: 'drive-1', path: 'about', isHomePage: false });

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

    await deletePageFromCustomHosts({ driveId: 'drive-1', path: 'about', isHomePage: false });

    expect(deletePublishedArtifact).not.toHaveBeenCalled();
  });

  it('is a no-op when publishing is not configured', async () => {
    vi.mocked(isPublishConfigured).mockReturnValue(false);

    await deletePageFromCustomHosts({ driveId: 'drive-1', path: 'about', isHomePage: false });

    expect(deletePublishedArtifact).not.toHaveBeenCalled();
  });

  it('swallows delete failures (best-effort)', async () => {
    mockSelect([{ hostname: 'a.example.com', status: 'active' }]);
    vi.mocked(deletePublishedArtifact).mockRejectedValueOnce(new Error('S3 down'));

    await expect(
      deletePageFromCustomHosts({ driveId: 'drive-1', path: 'about', isHomePage: false }),
    ).resolves.toBeUndefined();
  });
});

describe('mirrorDriveToCustomHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPublishConfigured).mockReturnValue(true);
    vi.mocked(publishedArtifactExists).mockResolvedValue(false);
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
