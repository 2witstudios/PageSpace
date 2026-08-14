import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { isFilePage } from '@pagespace/lib/content/page-types.config';
import { PageType } from '@pagespace/lib/utils/enums';
import { renderCanvasDocument } from '@pagespace/lib/canvas/render-document';
import { buildPreviewResponseHeaders } from '@pagespace/lib/canvas/preview-headers';
import { buildSiteCsp, buildBaselineCsp } from '@pagespace/lib/canvas/csp';
import {
  extractDashboardFileViewRefs,
  rewriteDashboardFileViewLinks,
} from '@/lib/canvas/file-view-links';
import { createCanvasFileViewToken } from '@/lib/canvas/file-view-token';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

/**
 * Resolve the short-lived view URLs for any dashboard file references the author
 * embedded, mirroring `POST /api/canvas/file-view-tokens` — which is what the
 * client used to call before this document was rendered server-side. Every ref is
 * re-checked against the VIEWER's own access, so an author cannot embed a file
 * the viewer may not see.
 */
async function resolveFileViewLinks(html: string, userId: string): Promise<string> {
  const refs = extractDashboardFileViewRefs(html);
  if (refs.length === 0) return html;

  const unique = Array.from(
    new Map(refs.map((ref) => [`${ref.driveId}:${ref.pageId}`, ref])).values(),
  );

  // eslint-disable-next-line no-restricted-syntax -- bounded by the refs embedded in one page, mirroring the file-view-tokens route
  const rows = await db.query.pages.findMany({
    where: inArray(pages.id, unique.map(({ pageId }) => pageId)),
    columns: { id: true, driveId: true, type: true },
  });
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  const urls = new Map<string, string>();
  await Promise.all(
    unique.map(async ({ driveId, pageId }) => {
      const row = rowsById.get(pageId);
      if (!row || row.driveId !== driveId || !isFilePage(row.type as PageType)) return;
      if (!(await canUserViewPage(userId, pageId))) return;
      const token = createCanvasFileViewToken({ driveId, pageId });
      urls.set(
        `${driveId}:${pageId}`,
        `/dashboard/${driveId}/${pageId}/view?token=${encodeURIComponent(token)}`,
      );
    }),
  );

  return rewriteDashboardFileViewLinks(html, ({ driveId, pageId }) =>
    urls.get(`${driveId}:${pageId}`),
  );
}

/**
 * In-app renderer for a CANVAS page, served as a real document at a real URL.
 *
 * `CanvasFrame` points its iframe here with `src` instead of inlining the HTML
 * with `srcDoc`. That distinction is the whole point: a `srcDoc` frame inherits
 * the EMBEDDER's Content-Security-Policy, so the dashboard's nonce-based policy
 * and narrow `connect-src` would apply to the author's document — and a
 * site-mode page's `fetch()` would work once published while dying in the
 * preview. A real navigation gets its own policy with nothing inherited, so what
 * the author sees while building is what they ship.
 *
 * The frame that loads this is still sandboxed WITHOUT `allow-same-origin`, so
 * despite the same-origin URL the document runs in an opaque origin with no
 * cookies and no access to the app. That invariant lives in `CanvasFrame`.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> },
) {
  const { pageId } = await context.params;

  const user = await verifyAuth(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { id: true, title: true, type: true, content: true, siteMode: true, isTrashed: true },
  });

  if (!page || page.isTrashed || page.type !== PageType.CANVAS) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!(await canUserViewPage(user.id, pageId))) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: user.id,
      resourceType: 'page',
      resourceId: pageId,
      details: { reason: 'no_view_access', surface: 'canvas_preview' },
      riskScore: 0.4,
    });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Same policy the published artifact carries, chosen by the same flag, so the
  // two cannot drift.
  const headers = buildPreviewResponseHeaders(
    page.siteMode ? buildSiteCsp() : buildBaselineCsp(),
  );

  // FAIL CLOSED. This route runs under middleware `skipCSP`, so the app does not
  // supply a policy of its own — an absent policy here would mean an unpoliced
  // frame running author script, silently. A broken preview is the acceptable
  // failure; that is not.
  if (!headers) {
    return NextResponse.json({ error: 'Preview policy unavailable' }, { status: 500 });
  }

  // Mirrors published_pages.themeBridgeEnabled (default true when the page has
  // never been published) so the preview matches what publishing produces.
  const published = await db.query.publishedPages.findFirst({
    where: eq(publishedPages.pageId, pageId),
    columns: { themeBridgeEnabled: true },
  });

  const html = renderCanvasDocument({
    html: await resolveFileViewLinks(page.content ?? '', user.id),
    title: page.title,
    baseTarget: '_blank',
    injectThemeBridge: published?.themeBridgeEnabled ?? true,
    navigationBridge: true,
    // Always injected: it only posts a message, which the parent ignores unless
    // it has something for Escape to close. Making it conditional would need a
    // query param, and a param that changes the document is a cache key we do
    // not want.
    escapeBridge: true,
    siteMode: page.siteMode,
  });

  return new NextResponse(html, { status: 200, headers });
}
