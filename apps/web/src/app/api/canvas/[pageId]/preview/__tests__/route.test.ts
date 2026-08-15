import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
      publishedPages: { findFirst: vi.fn() },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ field: a, value: b })),
  inArray: vi.fn((a, b) => ({ field: a, values: b })),
}));

vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id' } }));
vi.mock('@pagespace/db/schema/published-pages', () => ({
  publishedPages: { pageId: 'pageId' },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

vi.mock('@/lib/canvas/file-view-token', () => ({
  createCanvasFileViewToken: vi.fn(() => 'signed'),
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';

const request = () => new Request('http://localhost/api/canvas/page-1/preview');
const context = (pageId = 'page-1') => ({ params: Promise.resolve({ pageId }) });

/** A CSP as its list of whole directives, so two policies compare exactly. */
const directivesOf = (policy: string) =>
  policy.split(';').map((directive) => directive.trim()).filter(Boolean);

const canvasPage = (over: Record<string, unknown> = {}) => ({
  id: 'page-1',
  title: 'Welcome',
  type: 'CANVAS',
  content: '<p>hi</p>',
  siteMode: false,
  isTrashed: false,
  ...over,
});

describe('GET /api/canvas/[pageId]/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(canvasPage() as never);
    vi.mocked(db.query.publishedPages.findFirst).mockResolvedValue(undefined as never);
  });

  it('given no session, should 401 without touching the database', async () => {
    vi.mocked(verifyAuth).mockResolvedValue(null as never);

    const res = await GET(request(), context());

    expect(res.status).toBe(401);
    expect(db.query.pages.findFirst).not.toHaveBeenCalled();
  });

  it('given a viewer without VIEW access, should 403 and not render the document', async () => {
    vi.mocked(canUserViewPage).mockResolvedValue(false);

    const res = await GET(request(), context());

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('<p>hi</p>');
  });

  /**
   * Permission is checked BEFORE page type/state, so the status code cannot be
   * used to probe what a page is. Checking type first would make a CANVAS page
   * the caller cannot see answer 403 while everything else answers 404 — an
   * enumeration oracle over every page id in the system.
   */
  it('given no access, should answer identically whether or not the page exists', async () => {
    vi.mocked(canUserViewPage).mockResolvedValue(false);

    vi.mocked(db.query.pages.findFirst).mockResolvedValue(canvasPage() as never);
    const existing = await GET(request(), context());

    vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);
    const missing = await GET(request(), context());

    expect(existing.status).toBe(missing.status);
  });

  it('given no access, should answer identically whatever the page type is', async () => {
    vi.mocked(canUserViewPage).mockResolvedValue(false);

    vi.mocked(db.query.pages.findFirst).mockResolvedValue(canvasPage() as never);
    const canvas = await GET(request(), context());

    vi.mocked(db.query.pages.findFirst).mockResolvedValue(canvasPage({ type: 'DOCUMENT' }) as never);
    const document = await GET(request(), context());

    expect(canvas.status).toBe(document.status);
  });

  it('given a non-CANVAS page the viewer can see, should 404', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(canvasPage({ type: 'DOCUMENT' }) as never);

    expect((await GET(request(), context())).status).toBe(404);
  });

  it('given a trashed page, should 404', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(canvasPage({ isTrashed: true }) as never);

    expect((await GET(request(), context())).status).toBe(404);
  });

  it('given a viewable CANVAS page, should render it as sandboxed HTML', async () => {
    const res = await GET(request(), context());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('<p>hi</p>');
  });

  /**
   * This route runs under middleware `skipCSP`, so the app supplies no policy of
   * its own — an absent header here is not a weaker policy but NO policy, on a
   * document that executes author script.
   */
  it('given a rendered page, should carry a sandbox that never grants allow-same-origin', async () => {
    const csp = (await GET(request(), context())).headers.get('Content-Security-Policy') ?? '';

    expect(csp).toMatch(/(^|;)\s*sandbox\s/);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it('given a per-viewer document, should never be stored in a shared cache', async () => {
    const res = await GET(request(), context());

    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.headers.get('Cache-Control')).toContain('private');
  });

  it('given a siteMode page, should serve the site policy so preview matches publish', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(canvasPage({ siteMode: true }) as never);

    const csp = (await GET(request(), context())).headers.get('Content-Security-Policy') ?? '';

    expect(csp).toMatch(/script-src[^;]*\bhttps:/);
    expect(csp).toMatch(/connect-src[^;]*\bhttps:/);
  });

  /**
   * Publishing scopes `form-action`/`connect-src` to the app origin so a canvas
   * <form> can reach the public forms endpoint. The preview must compute the
   * same policy from the same env, or an author's form silently does nothing
   * while they build and then works once published.
   */
  it('given an app origin in the environment, should scope the preview policy to it too', async () => {
    const previous = process.env.WEB_APP_URL;
    process.env.WEB_APP_URL = 'https://app.pagespace.ai';
    try {
      const csp = (await GET(request(), context())).headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("form-action 'self' https://app.pagespace.ai");
      expect(csp).toContain('connect-src https://app.pagespace.ai');
    } finally {
      if (previous === undefined) delete process.env.WEB_APP_URL;
      else process.env.WEB_APP_URL = previous;
    }
  });

  it('given no app origin configured, should keep form submission closed', async () => {
    const prevWeb = process.env.WEB_APP_URL;
    const prevPublic = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.WEB_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    try {
      const csp = (await GET(request(), context())).headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("form-action 'none'");
    } finally {
      if (prevWeb !== undefined) process.env.WEB_APP_URL = prevWeb;
      if (prevPublic !== undefined) process.env.NEXT_PUBLIC_APP_URL = prevPublic;
    }
  });

  /**
   * The rendered document carries its own <meta> CSP, and browsers enforce the
   * INTERSECTION of every policy delivered. A header that permits form-action
   * while the meta still says 'none' is therefore inert — the fix has to reach
   * both, or it only looks applied.
   */
  it('given an app origin, should scope the meta policy too, not just the header', async () => {
    const previous = process.env.WEB_APP_URL;
    process.env.WEB_APP_URL = 'https://app.pagespace.ai';
    try {
      const body = await (await GET(request(), context())).text();
      expect(body).toContain("form-action 'self' https://app.pagespace.ai");
      expect(body).not.toContain("form-action 'none'");
    } finally {
      if (previous === undefined) delete process.env.WEB_APP_URL;
      else process.env.WEB_APP_URL = previous;
    }
  });

  /**
   * General invariant behind the two specific cases above: the document's <meta>
   * policy and the response header are built by separate calls that must be fed
   * the same inputs. Browsers intersect them, so any directive one grants and the
   * other withholds is silently withheld. This pins every base directive rather
   * than one parameter, so a third input added later cannot diverge unnoticed.
   */
  it.each([false, true])('given siteMode=%s, should deliver the same base policy in meta and header', async (siteMode) => {
    const previous = process.env.WEB_APP_URL;
    process.env.WEB_APP_URL = 'https://app.pagespace.ai';
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(canvasPage({ siteMode }) as never);
    try {
      const res = await GET(request(), context());
      const header = res.headers.get('Content-Security-Policy') ?? '';
      const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(await res.text())?.[1] ?? '';

      expect(meta).not.toBe('');
      // The header adds embedding/sandbox directives a <meta> cannot carry; every
      // directive the meta DOES declare must appear in the header unchanged.
      // Compared whole, not as a substring: `connect-src https://app.pagespace.ai`
      // is a substring of `connect-src https://app.pagespace.ai.evil`, so a
      // substring check would call a widened header identical.
      const headerDirectives = directivesOf(header);
      for (const directive of directivesOf(meta)) {
        expect(headerDirectives).toContain(directive);
      }
    } finally {
      if (previous === undefined) delete process.env.WEB_APP_URL;
      else process.env.WEB_APP_URL = previous;
    }
  });

  it('given a non-siteMode page, should serve the baseline policy', async () => {
    const csp = (await GET(request(), context())).headers.get('Content-Security-Policy') ?? '';

    expect(csp).not.toMatch(/connect-src[^;]*\bhttps:/);
  });
});
