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
import { buildCanvasCsp } from '@pagespace/lib/canvas/csp';
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

  // Permission FIRST, before the page is inspected at all. Checking type or
  // trashed-ness first would make a CANVAS page the caller cannot see answer 403
  // while every other id answers 404 — an oracle letting any signed-in user
  // enumerate which page ids exist and which of them are canvases. Since
  // `canUserViewPage` is false for a missing page too, this single check answers
  // identically for "does not exist" and "not yours".
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

  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { id: true, title: true, type: true, content: true, siteMode: true, isTrashed: true },
  });

  if (!page || page.isTrashed || page.type !== PageType.CANVAS) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Same policy the published artifact carries, chosen by the same flag and
  // resolved from the same environment, so the two cannot drift.
  //
  // `formActionOrigin` matters even though this is only a preview: publishing
  // scopes `form-action`/`connect-src` to the app origin so a canvas <form> can
  // reach the public forms endpoint, and computing it differently here is how an
  // author ends up with a form that silently does nothing while they build it
  // and then works once published. Resolved exactly as `publishCanvasPage` does.
  // Site mode needs no origin — `buildSiteCsp` already permits `form-action`
  // and `connect-src` to any https host.
  //
  // `buildCanvasCsp` is the SAME call `renderCanvasDocument` makes for the
  // document's own <meta> policy below, not a copy of it: browsers enforce the
  // intersection of every policy delivered, so a header and a meta chosen by two
  // hand-copied ternaries withhold whatever the copies disagree about.
  const formActionOrigin = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  const headers = buildPreviewResponseHeaders(buildCanvasCsp(page.siteMode, formActionOrigin));

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
    // Must match the origin baked into the response header above, for the same
    // intersection reason: a header that permits `form-action` while the meta
    // still says `'none'` is inert. Ignored under siteMode, which permits any
    // https origin without needing one.
    //
    // The inputs are threaded rather than the finished policy handed over as
    // `cspOverride`, which would make the two identical by construction: an
    // override is a whole-contract switch, and for a SITE-MODE page it also
    // turns off the CSS handling site mode grants, rewriting the external
    // `url()`/`@import` values such a page is allowed to keep. This route serves
    // both kinds of page from one call, so it cannot take that trade. What holds
    // the inputs together is the meta/header invariant test in this route's suite.
    formActionOrigin,
  });

  return new NextResponse(html, { status: 200, headers });
}
