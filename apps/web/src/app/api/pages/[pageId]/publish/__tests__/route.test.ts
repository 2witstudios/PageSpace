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

vi.mock('server-only', () => ({}));

const authenticateRequestWithOptions = vi.fn();
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => authenticateRequestWithOptions(...args),
  isAuthError: (result: unknown) => typeof result === 'object' && result !== null && 'error' in result,
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
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
vi.mock('@/lib/canvas/published-storage', () => ({
  buildPublishedKey: (...args: unknown[]) => buildPublishedKey(...args),
  putPublishedArtifact: (...args: unknown[]) => putPublishedArtifact(...args),
  deletePublishedArtifact: (...args: unknown[]) => deletePublishedArtifact(...args),
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

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
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

  it('returns 400 when the page is not a canvas page', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'DOCUMENT', title: 'T', content: 'x', driveId: 'drive-1' });
    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/canvas/i);
  });

  it('first-publish: allocates the subdomain, uploads, upserts the row, returns the url', async () => {
    findFirstPage.mockResolvedValue({ id: 'page-1', type: 'CANVAS', title: 'Welcome', content: '<p>hi</p>', driveId: 'drive-1' });
    findFirstDrive.mockResolvedValue({ id: 'drive-1', slug: 'Acme', publishSubdomain: null });

    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(200);

    // validates and persists the NORMALIZED candidate derived from the slug
    expect(validatePublishSubdomain).toHaveBeenCalledWith('acme');
    expect(updateWhere).toHaveBeenCalledTimes(1);

    expect(renderPublishedPage).toHaveBeenCalledWith({ html: '<p>hi</p>', title: 'Welcome' });
    expect(putPublishedArtifact).toHaveBeenCalledWith({ subdomain: 'acme', path: 'welcome', html: '<html>rendered</html>' });
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);

    const json = await res.json();
    expect(json).toEqual({
      url: 'https://acme.pagespace.site/welcome',
      subdomain: 'acme',
      path: 'welcome',
    });
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
    expect(updateWhere).not.toHaveBeenCalled();

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

  it('returns { published: false } when no row exists', async () => {
    findFirstPublished.mockResolvedValue(undefined);
    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ published: false });
    expect(findFirstDrive).not.toHaveBeenCalled();
  });

  it('returns { published: true, url } when a row exists', async () => {
    findFirstPublished.mockResolvedValue({ driveId: 'drive-1', path: 'welcome' });
    findFirstDrive.mockResolvedValue({ publishSubdomain: 'acme' });

    const res = await GET(makeReq(), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      published: true,
      url: 'https://acme.pagespace.site/welcome',
      subdomain: 'acme',
      path: 'welcome',
    });
  });
});

describe('DELETE /api/pages/[pageId]/publish', () => {
  it('returns 403 when the user cannot edit the page', async () => {
    canUserEditPage.mockResolvedValue(false);
    const res = await DELETE(makeReq(), { params });
    expect(res.status).toBe(403);
  });

  it('removes the artifact and row, returns 200', async () => {
    findFirstPublished.mockResolvedValue({ id: 'pub-1', artifactKey: 'published/acme/welcome/index.html' });

    const res = await DELETE(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(deletePublishedArtifact).toHaveBeenCalledWith('published/acme/welcome/index.html');
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
});
