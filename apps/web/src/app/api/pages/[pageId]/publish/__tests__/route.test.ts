/**
 * Contract tests for /api/pages/[pageId]/publish
 *
 * Verifies the publish/unpublish handler contract:
 * - Edit-permission gating (403)
 * - Canvas-only enforcement (400)
 * - Subdomain allocation + validation on first publish
 * - Artifact upload + row upsert
 * - Republish reuse of an existing subdomain
 * - Unpublish removes artifact + row, 404 when nothing published
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST, DELETE } from '../route';
import { getActiveDomainRecords } from '@/lib/canvas/custom-domain-mirror';

vi.mock('server-only', () => ({}));

const authenticateRequestWithOptions = vi.fn();
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => authenticateRequestWithOptions(...args),
  isAuthError: (result: unknown) => typeof result === 'object' && result !== null && 'error' in result,
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  canPrincipalEditPage: (auth: { userId: string }, pageId: string) => canUserEditPage(auth.userId, pageId),
}));

const canUserEditPage = vi.fn();
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserEditPage: (...args: unknown[]) => canUserEditPage(...args),
}));

const validatePublishSubdomain = vi.fn();
vi.mock('@pagespace/lib/validators/subdomain', () => ({
  normalizeSubdomain: (input: string) =>
    input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, ''),
  validatePublishSubdomain: (...args: unknown[]) => validatePublishSubdomain(...args),
}));

vi.mock('@pagespace/lib/utils/utils', () => ({
  slugify: (text: string) =>
    text.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/--+/g, '-').replace(/^-+/, '').replace(/-+$/, ''),
}));

const buildPublishedKey = vi.fn();
const putPublishedArtifact = vi.fn();
const deletePublishedArtifact = vi.fn();
const isPublishConfigured = vi.fn();
const getPublishAssetBaseUrl = vi.fn();
vi.mock('@/lib/canvas/published-storage', () => ({
  buildPublishedKey: (...args: unknown[]) => buildPublishedKey(...args),
  putPublishedArtifact: (...args: unknown[]) => putPublishedArtifact(...args),
  deletePublishedArtifact: (...args: unknown[]) => deletePublishedArtifact(...args),
  isPublishConfigured: (...args: unknown[]) => isPublishConfigured(...args),
  getPublishAssetBaseUrl: (...args: unknown[]) => getPublishAssetBaseUrl(...args),
}));

const rewriteCanvasAssets = vi.fn();
const rewriteInterPageLinksForDrive = vi.fn();
const extractAndStripOgMeta = vi.fn();
vi.mock('@/lib/canvas/asset-pipeline', () => ({
  rewriteCanvasAssets: (...args: unknown[]) => rewriteCanvasAssets(...args),
  rewriteInterPageLinksForDrive: (...args: unknown[]) => rewriteInterPageLinksForDrive(...args),
  extractAndStripOgMeta: (...args: unknown[]) => extractAndStripOgMeta(...args),
}));

const renderPublishedPage = vi.fn();
vi.mock('@/lib/canvas/render-published', () => ({
  renderPublishedPage: (...args: unknown[]) => renderPublishedPage(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/canvas/custom-domain-mirror', () => ({
  mirrorPublishedPageToHosts: vi.fn().mockResolvedValue(undefined),
  mirror404ToHosts: vi.fn().mockResolvedValue(undefined),
  deletePageFromCustomHosts: vi.fn().mockResolvedValue(undefined),
  getActiveDomainRecords: vi.fn().mockResolvedValue([]),
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id' },
  drives: { id: 'drives.id' },
}));

vi.mock('@pagespace/db/schema/published-pages', () => ({
  publishedPages: { pageId: 'publishedPages.pageId' },
}));

// In-memory db mock with controllable query results.
const findFirstPage = vi.fn();
const findFirstDrive = vi.fn();
const findFirstPublished = vi.fn();
const updateWhere = vi.fn().mockResolvedValue(undefined);
const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
const deleteWhere = vi.fn().mockResolvedValue(undefined);

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: (...a: unknown[]) => findFirstPage(...a) },
      drives: { findFirst: (...a: unknown[]) => findFirstDrive(...a) },
      publishedPages: { findFirst: (...a: unknown[]) => findFirstPublished(...a) },
    },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: (...a: unknown[]) => updateWhere(...a) })) })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ onConflictDoUpdate: (...a: unknown[]) => onConflictDoUpdate(...a) })),
    })),
    delete: vi.fn(() => ({ where: (...a: unknown[]) => deleteWhere(...a) })),
  },
}));

const makeReq = (body?: unknown): Request =>
  ({ json: async () => (body === undefined ? Promise.reject(new Error('no body')) : body) } as unknown as Request);

const params = Promise.resolve({ pageId: 'page-1' });

beforeEach(() => {
  vi.clearAllMocks();
  authenticateRequestWithOptions.mockResolvedValue({ userId: 'user-1' });
  canUserEditPage.mockResolvedValue(true);
  validatePublishSubdomain.mockReturnValue({ valid: true });
  isPublishConfigured.mockReturnValue(true);
  getPublishAssetBaseUrl.mockReturnValue('https://test-publish.t3.tigrisfiles.io');
  rewriteCanvasAssets.mockImplementation(async ({ html }: { html: string }) => ({ html }));
  rewriteInterPageLinksForDrive.mockImplementation(async ({ html }: { html: string }) => ({ html }));
  extractAndStripOgMeta.mockImplementation((html: string) => ({ meta: {}, html }));
  buildPublishedKey.mockImplementation((subdomain: string, path: string) => `published/${subdomain}/${path}/index.html`);
  putPublishedArtifact.mockResolvedValue({ key: 'published/acme/welcome/index.html' });
  renderPublishedPage.mockReturnValue('<html>rendered</html>');
  updateWhere.mockResolvedValue(undefined);
  onConflictDoUpdate.mockResolvedValue(undefined);
  deleteWhere.mockResolvedValue(undefined);
});

describe('POST /api/pages/[pageId]/publish', () => {
  it('returns 403 when the user cannot edit the page', async () => {
    canUserEditPage.mockResolvedValue(false);
    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(403);
  });

  it('returns 503 when publishing is disabled via the kill-switch', async () => {
    const prev = process.env.CANVAS_PUBLISHING_DISABLED;
    process.env.CANVAS_PUBLISHING_DISABLED = 'true';
    try {
      const res = await POST(makeReq({}), { params });
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toMatch(/disabled/i);
      expect(putPublishedArtifact).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.CANVAS_PUBLISHING_DISABLED;
      else process.env.CANVAS_PUBLISHING_DISABLED = prev;
    }
  });

  it('returns 503 and touches nothing when the publish bucket is not configured', async () => {
    isPublishConfigured.mockReturnValue(false);
    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/not configured/i);
    // fails fast BEFORE any DB reservation or upload
    expect(onConflictDoUpdate).not.toHaveBeenCalled();
    expect(putPublishedArtifact).not.toHaveBeenCalled();
  });

  it('returns 404 and touches nothing when the page does not exist', async () => {
    findFirstPage.mockResolvedValue(undefined);
    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(404);
    expect(onConflictDoUpdate).not.toHaveBeenCalled();
    expect(putPublishedArtifact).not.toHaveBeenCalled();
  });

  it('returns 400 when the page is not a canvas page', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'DOCUMENT', title: 'T', content: 'x', driveId: 'drive-1' });
    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/canvas/i);
  });

  it('returns 403 and touches nothing when the page is in a Home drive', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<p>hi</p>', driveId: 'drive-home' });
    findFirstDrive.mockResolvedValue({ id: 'drive-home', slug: 'home', kind: 'HOME', publishSubdomain: null });

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/home/i);
    // Must not allocate subdomain, upload, or write any row.
    expect(updateWhere).not.toHaveBeenCalled();
    expect(putPublishedArtifact).not.toHaveBeenCalled();
    expect(onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('first-publish: allocates the subdomain, uploads, upserts the row, returns the url', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<p>hi</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'Acme', publishSubdomain: null });

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(200);

    // validates and persists the NORMALIZED candidate derived from the slug
    expect(validatePublishSubdomain).toHaveBeenCalledWith('acme');
    // 2 updates: subdomain allocation + post-upload updatedAt advancement
    expect(updateWhere).toHaveBeenCalledTimes(2);

    expect(rewriteCanvasAssets).toHaveBeenCalledWith({ html: '<p>hi</p>', userId: 'user-1', db: expect.any(Object) });
    expect(renderPublishedPage).toHaveBeenCalledWith(expect.objectContaining({ html: '<p>hi</p>', title: 'Welcome', assetBaseUrl: 'https://test-publish.t3.tigrisfiles.io', faviconBaseUrl: 'https://pagespace.ai', pageUrl: 'https://acme.pagespace.site/welcome', description: 'hi' }));
    // With no noindex override, the resolver forwards the explicit index default.
    const firstCallArg = renderPublishedPage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCallArg.robots).toBe('index, follow');
    expect(putPublishedArtifact).toHaveBeenCalledWith({ subdomain: 'acme', path: 'welcome', html: '<html>rendered</html>' });
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);

    const json = await res.json();
    expect(json).toEqual({
      url: 'https://acme.pagespace.site/welcome',
      subdomain: 'acme',
      path: 'welcome',
      isHomePage: false,
    });
  });

  it('publishing the drive home page mirrors it to the subdomain root and returns the root url', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<p>hi</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'STANDARD', homePageId: 'page-1' });

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(200);

    // The home page's primary public URL is the subdomain ROOT, so its baked
    // canonical/OG/JSON-LD URL must be the root — not the secondary slug path
    // (otherwise the root page canonicalizes itself away to /welcome).
    expect(renderPublishedPage).toHaveBeenCalledWith(expect.objectContaining({ pageUrl: 'https://acme.pagespace.site/' }));

    // Two uploads: the slug artifact + the stable root mirror.
    expect(putPublishedArtifact).toHaveBeenCalledWith({ subdomain: 'acme', path: 'welcome', html: '<html>rendered</html>' });
    expect(putPublishedArtifact).toHaveBeenCalledWith({ subdomain: 'acme', path: '', html: '<html>rendered</html>' });

    const json = await res.json();
    expect(json).toEqual({
      url: 'https://acme.pagespace.site/',
      subdomain: 'acme',
      path: 'welcome',
      isHomePage: true,
    });
  });

  it('uses og:image and og:description from canvas meta tags when present', async () => {
    const ogImg = 'https://cdn.pagespace.site/assets/files/abc/original';
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Gallery', content: '<p>hi</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'PERSONAL' });
    findFirstPublished.mockResolvedValue(null);
    extractAndStripOgMeta.mockReturnValue({ meta: { ogImageUrl: ogImg, ogDescription: 'My gallery' }, html: '<p>hi</p>' });

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(200);
    expect(renderPublishedPage).toHaveBeenCalledWith(expect.objectContaining({ ogImageUrl: ogImg, ogDescription: 'My gallery' }));
  });

  it('passes the author og:description through as the SEO meta description when present', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Gallery', content: '<p>body text</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'PERSONAL' });
    findFirstPublished.mockResolvedValue(null);
    extractAndStripOgMeta.mockReturnValue({ meta: { ogDescription: 'Curated blurb' }, html: '<p>body text</p>' });

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(200);
    expect(renderPublishedPage).toHaveBeenCalledWith(expect.objectContaining({ description: 'Curated blurb' }));
  });

  it('derives the SEO meta description from page content when no og:description is set', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Plain', content: '<h1>Title</h1><p>Real body copy.</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'PERSONAL' });
    findFirstPublished.mockResolvedValue(null);
    extractAndStripOgMeta.mockReturnValue({ meta: {}, html: '<h1>Title</h1><p>Real body copy.</p>' });

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(200);
    expect(renderPublishedPage).toHaveBeenCalledWith(expect.objectContaining({ description: 'Title Real body copy.' }));
  });

  it('uses favicon from canvas link rel=icon when present and skips faviconBaseUrl', async () => {
    const faviconHref = 'https://cdn.pagespace.site/assets/files/icon/original';
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Branded', content: '<p>hi</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'PERSONAL' });
    findFirstPublished.mockResolvedValue(null);
    extractAndStripOgMeta.mockReturnValue({ meta: { faviconHref }, html: '<p>hi</p>' });

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(200);
    expect(renderPublishedPage).toHaveBeenCalledWith(expect.objectContaining({ faviconHref, faviconBaseUrl: undefined }));
  });

  it('falls back to faviconBaseUrl when canvas has no link rel=icon', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Plain', content: '<p>hi</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'PERSONAL' });
    findFirstPublished.mockResolvedValue(null);
    extractAndStripOgMeta.mockReturnValue({ meta: {}, html: '<p>hi</p>' });

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(200);
    expect(renderPublishedPage).toHaveBeenCalledWith(expect.objectContaining({ faviconBaseUrl: 'https://pagespace.ai', faviconHref: undefined }));
  });

  it('accepts SEO overrides and threads them into the rendered page', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<p>hi</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'STANDARD' });
    findFirstPublished.mockResolvedValue(null);

    const res = await POST(makeReq({ title: 'Custom Title', description: 'Custom desc', noindex: true }), { params });
    expect(res.status).toBe(200);
    expect(renderPublishedPage).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Custom Title',
      description: 'Custom desc',
      robots: 'noindex',
    }));
  });

  it('returns 400 when ogImageUrl is not a valid URL', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<p>hi</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'STANDARD' });

    const res = await POST(makeReq({ ogImageUrl: 'not-a-url' }), { params });
    expect(res.status).toBe(400);
    // Schema rejected the body before any artifact write.
    expect(putPublishedArtifact).not.toHaveBeenCalled();
  });

  it('accepts an empty-string ogImageUrl (clears the override)', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<p>hi</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'acme', kind: 'STANDARD' });
    findFirstPublished.mockResolvedValue(null);

    const res = await POST(makeReq({ ogImageUrl: '' }), { params });
    expect(res.status).toBe(200);
  });

  it('returns 400 when the requested subdomain is invalid/reserved', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: 'x', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: null });
    validatePublishSubdomain.mockReturnValue({ valid: false, reason: 'Subdomain "admin" is reserved' });

    const res = await POST(makeReq({ subdomain: 'admin' }), { params });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/reserved/i);
    expect(updateWhere).not.toHaveBeenCalled();
    expect(putPublishedArtifact).not.toHaveBeenCalled();
  });

  it('returns 409 when the chosen subdomain is already taken', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: 'x', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: null });
    updateWhere.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(409);
  });

  it('republish: reuses the existing subdomain, re-uploads, updates the row', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<p>v2</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'existing' });

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(200);

    // no new allocation when the drive already owns a subdomain
    expect(validatePublishSubdomain).not.toHaveBeenCalled();
    // 1 update: post-upload updatedAt advancement only (no subdomain allocation)
    expect(updateWhere).toHaveBeenCalledTimes(1);

    expect(putPublishedArtifact).toHaveBeenCalledWith({ subdomain: 'existing', path: 'welcome', html: '<html>rendered</html>' });
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);

    const json = await res.json();
    expect(json.subdomain).toBe('existing');
    expect(json.url).toBe('https://existing.pagespace.site/welcome');
  });

  it('returns 409 and does NOT upload when the resolved path is owned by another page (P1)', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: 'x', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'existing' });
    // The (driveId, path) reservation collides with another page's existing row.
    onConflictDoUpdate.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(409);
    // Critical: storage is never written when the path is already owned by another page.
    expect(putPublishedArtifact).not.toHaveBeenCalled();
  });

  it('does NOT advance updatedAt when the artifact upload fails', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: 'x', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'existing' });
    putPublishedArtifact.mockRejectedValue(new Error('S3 unavailable'));

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(500);
    // updatedAt update must be skipped — upload failed, artifact is still old version
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it('deletes the stale artifact when republishing changes the resolved key (P2)', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: 'x', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'acme', publishSubdomain: 'existing' });
    // Page previously published under a different path/key.
    findFirstPublished.mockResolvedValue({ artifactKey: 'published/existing/old-title/index.html' });

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(200);
    expect(putPublishedArtifact).toHaveBeenCalled();
    // The previous (different) artifact is removed so no stale URL is left servable.
    expect(deletePublishedArtifact).toHaveBeenCalledWith('published/existing/old-title/index.html');
  });
});

describe('GET /api/pages/[pageId]/publish', () => {
  it('returns 403 when the user cannot edit the page', async () => {
    canUserEditPage.mockResolvedValue(false);
    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(403);
  });

  it('returns { published: false, available: true } when no row exists and publishing is configured', async () => {
    findFirstPublished.mockResolvedValue(undefined);
    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ published: false, available: true });
  });

  it('returns available: false when the page is in a Home drive (no published row)', async () => {
    findFirstPublished.mockResolvedValue(undefined);
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', driveId: 'drive-home' });
    findFirstDrive.mockResolvedValue({ kind: 'HOME', publishSubdomain: null });

    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.available).toBe(false);
    expect(json.published).toBe(false);
  });

  it('reports available: false when the publish bucket is not configured (UI hides the control)', async () => {
    isPublishConfigured.mockReturnValue(false);
    findFirstPublished.mockResolvedValue(undefined);
    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ published: false, available: false });
  });

  it('reports available: false when the kill-switch is engaged even if the bucket is configured', async () => {
    const prev = process.env.CANVAS_PUBLISHING_DISABLED;
    process.env.CANVAS_PUBLISHING_DISABLED = 'true';
    try {
      isPublishConfigured.mockReturnValue(true);
      findFirstPublished.mockResolvedValue(undefined);
      const res = await GET(makeReq(), { params });
      expect(res.status).toBe(200);
      const json = await res.json();
      // POST would 503 ("temporarily disabled") here, so the UI must hide the control.
      expect(json).toEqual({ published: false, available: false });
    } finally {
      if (prev === undefined) delete process.env.CANVAS_PUBLISHING_DISABLED;
      else process.env.CANVAS_PUBLISHING_DISABLED = prev;
    }
  });

  it('returns { published: true, url, available, isStale: false } when page is up to date', async () => {
    const publishedAt = new Date('2024-01-01T10:00:00Z');
    const updatedAt = new Date('2024-01-01T10:00:01Z'); // published AFTER last edit
    findFirstPublished.mockResolvedValue({ driveId: 'drive-1', path: 'welcome', publishedAt, updatedAt });
    findFirstDrive.mockResolvedValue({ publishSubdomain: 'acme' });
    findFirstPage.mockResolvedValue({ updatedAt: new Date('2024-01-01T09:55:00Z') }); // edited before publish

    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      published: true,
      available: true,
      isStale: false,
      url: 'https://acme.pagespace.site/welcome',
      subdomain: 'acme',
      path: 'welcome',
      isHomePage: false,
      title: null,
      description: null,
      ogImageUrl: null,
      noindex: false,
    });
  });

  it('returns the persisted SEO overrides so the publish dialog can pre-fill', async () => {
    const ts = new Date('2024-01-01T10:00:00Z');
    findFirstPublished.mockResolvedValue({
      driveId: 'drive-1', path: 'welcome', publishedAt: ts, updatedAt: ts,
      publishTitle: 'Custom Title', publishDescription: 'Custom desc',
      publishOgImageUrl: 'https://img.example/og.png', noindex: true,
    });
    findFirstDrive.mockResolvedValue({ publishSubdomain: 'acme' });
    findFirstPage.mockResolvedValue({ updatedAt: ts });

    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      title: 'Custom Title',
      description: 'Custom desc',
      ogImageUrl: 'https://img.example/og.png',
      noindex: true,
    });
  });

  it('returns the primary custom-domain URL when an active custom domain exists', async () => {
    const publishedAt = new Date('2024-01-01T10:00:00Z');
    const updatedAt = new Date('2024-01-01T10:00:01Z');
    findFirstPublished.mockResolvedValue({ driveId: 'drive-1', path: 'welcome', publishedAt, updatedAt });
    findFirstDrive.mockResolvedValue({ publishSubdomain: 'acme' });
    findFirstPage.mockResolvedValue({ updatedAt: new Date('2024-01-01T09:55:00Z') });
    vi.mocked(getActiveDomainRecords).mockResolvedValueOnce([
      { hostname: 'www.acme.com', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);

    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    // url is the branded host; subdomain is still reported for reference.
    expect(json.url).toBe('https://www.acme.com/welcome');
    expect(json.subdomain).toBe('acme');
  });

  it('returns a null url when the drive has no publish subdomain (degenerate)', async () => {
    const publishedAt = new Date('2024-01-01T10:00:00Z');
    const updatedAt = new Date('2024-01-01T10:00:01Z');
    findFirstPublished.mockResolvedValue({ driveId: 'drive-1', path: 'welcome', publishedAt, updatedAt });
    findFirstDrive.mockResolvedValue({ publishSubdomain: null });
    findFirstPage.mockResolvedValue({ updatedAt: new Date('2024-01-01T09:55:00Z') });

    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.url).toBeNull();
    // No active-domain lookup is attempted without a subdomain to fall back to.
    expect(getActiveDomainRecords).not.toHaveBeenCalled();
  });

  it('reports the subdomain root as the URL when the published page is the drive home page', async () => {
    const publishedAt = new Date('2024-01-01T10:00:00Z');
    const updatedAt = new Date('2024-01-01T10:00:01Z');
    findFirstPublished.mockResolvedValue({ driveId: 'drive-1', path: 'welcome', publishedAt, updatedAt });
    findFirstDrive.mockResolvedValue({ publishSubdomain: 'acme', homePageId: 'page-1' });
    findFirstPage.mockResolvedValue({ updatedAt: new Date('2024-01-01T09:55:00Z') });

    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.isHomePage).toBe(true);
    expect(json.url).toBe('https://acme.pagespace.site/');
    expect(json.path).toBe('welcome');
  });

  it('returns isStale: true when the page was edited after its last publish', async () => {
    const publishedAt = new Date('2024-01-01T10:00:00Z');
    const updatedAt = new Date('2024-01-01T10:00:00Z');
    findFirstPublished.mockResolvedValue({ driveId: 'drive-1', path: 'welcome', publishedAt, updatedAt });
    findFirstDrive.mockResolvedValue({ publishSubdomain: 'acme' });
    findFirstPage.mockResolvedValue({ updatedAt: new Date('2024-01-01T11:00:00Z') }); // edited AFTER publish

    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.isStale).toBe(true);
  });

  it('falls back to publishedAt when updatedAt is null (legacy row)', async () => {
    const publishedAt = new Date('2024-01-01T10:00:00Z');
    findFirstPublished.mockResolvedValue({ driveId: 'drive-1', path: 'welcome', publishedAt, updatedAt: null });
    findFirstDrive.mockResolvedValue({ publishSubdomain: 'acme' });
    findFirstPage.mockResolvedValue({ updatedAt: new Date('2024-01-01T11:00:00Z') }); // edited after first publish

    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.isStale).toBe(true);
  });

  it('returns isStale: false when page.updatedAt equals the publish timestamp (not strictly after)', async () => {
    const ts = new Date('2024-01-01T10:00:00Z');
    findFirstPublished.mockResolvedValue({ driveId: 'drive-1', path: 'welcome', publishedAt: ts, updatedAt: ts });
    findFirstDrive.mockResolvedValue({ publishSubdomain: 'acme' });
    findFirstPage.mockResolvedValue({ updatedAt: ts }); // same instant — not stale

    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.isStale).toBe(false);
  });

  it('returns isStale: false when the live page has no updatedAt', async () => {
    findFirstPublished.mockResolvedValue({
      driveId: 'drive-1', path: 'welcome',
      publishedAt: new Date('2024-01-01T10:00:00Z'),
      updatedAt: new Date('2024-01-01T10:00:00Z'),
    });
    findFirstDrive.mockResolvedValue({ publishSubdomain: 'acme' });
    findFirstPage.mockResolvedValue({ updatedAt: null });

    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.isStale).toBe(false);
  });
});

describe('DELETE /api/pages/[pageId]/publish', () => {
  it('returns 403 when the user cannot edit the page', async () => {
    canUserEditPage.mockResolvedValue(false);
    const res = await DELETE(makeReq(), { params });
    expect(res.status).toBe(403);
  });

  it('removes the artifact and row, returns 200', async () => {
    findFirstPublished.mockResolvedValue({ id: 'pub-1', artifactKey: 'published/acme/welcome/index.html', driveId: 'drive-1' });
    // Not the home page → no root-mirror cleanup.
    findFirstDrive.mockResolvedValue({ homePageId: 'other-page' });

    const res = await DELETE(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(deletePublishedArtifact).toHaveBeenCalledWith('published/acme/welcome/index.html');
    expect(deletePublishedArtifact).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    const json = await res.json();
    expect(json).toEqual({ unpublished: true });
  });

  it('returns 404 when nothing is published', async () => {
    findFirstPublished.mockResolvedValue(undefined);
    const res = await DELETE(makeReq(), { params });
    expect(res.status).toBe(404);
    expect(deletePublishedArtifact).not.toHaveBeenCalled();
  });

  it('also clears the subdomain root mirror when unpublishing the drive home page', async () => {
    findFirstPublished.mockResolvedValue({ id: 'pub-1', artifactKey: 'published/acme/welcome/index.html', driveId: 'drive-1' });
    findFirstDrive
      // DELETE handler: is this page the drive's home page?
      .mockResolvedValueOnce({ homePageId: 'page-1' })
      // clearPublishedHomeRoot: resolve the subdomain for the root key
      .mockResolvedValueOnce({ publishSubdomain: 'acme' });

    const res = await DELETE(makeReq(), { params });
    expect(res.status).toBe(200);
    // The slug artifact and the root mirror are both deleted.
    expect(deletePublishedArtifact).toHaveBeenCalledWith('published/acme/welcome/index.html');
    expect(buildPublishedKey).toHaveBeenCalledWith('acme', '');
    expect(deletePublishedArtifact).toHaveBeenCalledTimes(2);
  });

  it('returns 500 and does NOT delete the row when clearing the home-page root mirror fails (retryable)', async () => {
    findFirstPublished.mockResolvedValue({ id: 'pub-1', artifactKey: 'published/acme/welcome/index.html', driveId: 'drive-1' });
    findFirstDrive
      .mockResolvedValueOnce({ homePageId: 'page-1' })
      .mockResolvedValueOnce({ publishSubdomain: 'acme' });
    // Slug delete succeeds; the root-mirror delete fails.
    deletePublishedArtifact.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('S3 down'));

    const res = await DELETE(makeReq(), { params });
    expect(res.status).toBe(500);
    // The DB row must survive so the unpublish can be retried.
    expect(deleteWhere).not.toHaveBeenCalled();
  });
});
