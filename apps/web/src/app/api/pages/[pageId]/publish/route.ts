import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isPublishConfigured } from '@/lib/canvas/published-storage';
import { publishCanvasPage, clearPublishedHomeRoot, regeneratePublishedSiteFiles, PublishError, PUBLISH_HOST } from '@/lib/canvas/publish-page';
import { deletePageFromCustomHosts, getActiveDomainRecords } from '@/lib/canvas/custom-domain-mirror';
import { resolvePrimaryPublishedHost } from '@pagespace/lib/canvas/primary-host';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { isHomeDrive, homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { drives, pages } from '@pagespace/db/schema/core';
import { resolveUploadedImageAssetUrl } from '@/lib/canvas/asset-pipeline';
import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';
import { canPrincipalEditPage } from '@/lib/auth/principal-permissions';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const publishSchema = z.object({
  subdomain: z.string().optional(),
  path: z.string().optional(),
  // Author SEO overrides. Empty string clears a persisted override; an absent
  // field leaves it unchanged. ogImageUrl must be a valid URL when non-empty.
  title: z.string().max(300).optional(),
  description: z.string().max(1000).optional(),
  ogImageUrl: z.union([z.literal(''), z.url()]).optional(),
  // Alternative to pasting a URL: reference an uploaded FILE page, resolved
  // server-side (below) to a durable public CDN URL before it ever reaches
  // publishCanvasPage — never trusted as a URL directly.
  ogImageFileId: z.string().min(1).optional(),
  noindex: z.boolean().optional(),
}).nullable();

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to view this page' }, { status: 403 });
  }

  try {
    let available =
      isPublishConfigured() && process.env.CANVAS_PUBLISHING_DISABLED !== 'true';

    const row = await db.query.publishedPages.findFirst({
      where: eq(publishedPages.pageId, pageId),
      columns: {
        driveId: true,
        path: true,
        publishedAt: true,
        updatedAt: true,
        publishTitle: true,
        publishDescription: true,
        publishOgImageUrl: true,
        noindex: true,
      },
    });

    if (!row) {
      if (available) {
        const pg = await db.query.pages.findFirst({
          where: eq(pages.id, pageId),
          columns: { driveId: true },
        });
        if (pg) {
          const drv = await db.query.drives.findFirst({
            where: eq(drives.id, pg.driveId),
            columns: { kind: true },
          });
          if (drv?.kind === 'HOME') available = false;
        }
      }
      return NextResponse.json({ published: false, available });
    }

    const [drive, livePage] = await Promise.all([
      db.query.drives.findFirst({
        where: eq(drives.id, row.driveId),
        columns: { publishSubdomain: true, homePageId: true },
      }),
      db.query.pages.findFirst({
        where: eq(pages.id, pageId),
        columns: { updatedAt: true },
      }),
    ]);

    const subdomain = drive?.publishSubdomain ?? null;
    const lastPublishedAt = row.updatedAt ?? row.publishedAt;
    const isStale =
      livePage?.updatedAt != null && lastPublishedAt != null
        ? livePage.updatedAt > lastPublishedAt
        : false;

    // Resolve the drive's primary published host: the user-selected (or
    // earliest-created) active custom domain, falling back to the pagespace.site
    // subdomain. This is the branded link visitors should land on, so it's what
    // the publish control displays and copies.
    const activeDomains = subdomain ? await getActiveDomainRecords(row.driveId) : [];
    const primaryHost = subdomain
      ? resolvePrimaryPublishedHost({ subdomain, publishHost: PUBLISH_HOST, activeDomains })
      : null;

    // The home page is served at the host root (in addition to its slug), so
    // report the root as its primary URL. `primaryHost` is only null when the
    // drive somehow has no publish subdomain (a published page always has one);
    // returning a null url then is cleaner than emitting a broken `https://null/`.
    const isHomePage = drive?.homePageId === pageId;
    const url = primaryHost
      ? (isHomePage ? `https://${primaryHost}/` : `https://${primaryHost}/${row.path}`)
      : null;

    return NextResponse.json({
      published: true,
      available,
      isStale,
      url,
      subdomain,
      path: row.path,
      isHomePage,
      // Persisted author SEO overrides, so the publish dialog can pre-fill.
      title: row.publishTitle ?? null,
      description: row.publishDescription ?? null,
      ogImageUrl: row.publishOgImageUrl ?? null,
      noindex: row.noindex ?? false,
    });
  } catch (error) {
    loggers.api.error('Error reading publish status:', error as Error);
    return NextResponse.json({ error: 'Failed to read publish status' }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to publish this page' }, { status: 403 });
  }

  if (process.env.CANVAS_PUBLISHING_DISABLED === 'true') {
    return NextResponse.json({ error: 'Publishing is temporarily disabled' }, { status: 503 });
  }

  if (!isPublishConfigured()) {
    return NextResponse.json({ error: 'Publishing is not configured' }, { status: 503 });
  }

  // Resolve the page's drive up front: reject Home drives before any DB
  // reservation, and return a deterministic 404 for a missing/deleted page
  // instead of dereferencing a null below.
  const pageCheck = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { driveId: true },
  });
  if (!pageCheck) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }
  const drv = await db.query.drives.findFirst({
    where: eq(drives.id, pageCheck.driveId),
    columns: { id: true, kind: true },
  });
  if (drv && isHomeDrive(drv)) {
    return NextResponse.json({ error: homeDriveActionError(drv, 'publish') }, { status: 403 });
  }

  try {
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const parsedBody = publishSchema.parse(body);

    let ogImageUrl = parsedBody?.ogImageUrl;
    if (parsedBody?.ogImageFileId) {
      const resolved = await resolveUploadedImageAssetUrl({ fileId: parsedBody.ogImageFileId, driveId: pageCheck.driveId, userId, db });
      if (!resolved) {
        return NextResponse.json({ error: 'Selected image is unavailable or not accessible' }, { status: 400 });
      }
      ogImageUrl = resolved;
    }

    const result = await publishCanvasPage({
      pageId,
      driveId: pageCheck.driveId,
      userId,
      path: parsedBody?.path,
      subdomain: parsedBody?.subdomain,
      title: parsedBody?.title,
      description: parsedBody?.description,
      ogImageUrl,
      noindex: parsedBody?.noindex,
    });

    auditRequest(req, {
      eventType: 'data.write',
      userId,
      resourceType: 'page',
      resourceId: pageId,
      details: { operation: 'publish' },
    });

    return NextResponse.json(result);
  } catch (error) {
    loggers.api.error('Error publishing page:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Failed to publish page';
    const statusCode = error instanceof PublishError ? error.statusCode : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to unpublish this page' }, { status: 403 });
  }

  try {
    const row = await db.query.publishedPages.findFirst({
      where: eq(publishedPages.pageId, pageId),
      columns: { id: true, artifactKey: true, driveId: true, path: true },
    });

    if (!row) {
      return NextResponse.json({ error: 'Page is not published' }, { status: 404 });
    }

    // If this page is the drive's home page it was also mirrored to the
    // subdomain root. Clear that mirror BEFORE deleting the DB row so a failed
    // root delete surfaces as an error with the row still present — i.e. the
    // unpublish is retryable and never reports success while the page is still
    // publicly reachable at the root.
    const drv = await db.query.drives.findFirst({
      where: eq(drives.id, row.driveId),
      columns: { homePageId: true },
    });

    const isHomePage = drv?.homePageId === pageId;
    const { deletePublishedArtifact } = await import('@/lib/canvas/published-storage');
    await deletePublishedArtifact(row.artifactKey);
    if (isHomePage) {
      await clearPublishedHomeRoot(row.driveId);
    }
    // Remove the page artifact (and root mirror) from every active custom-domain
    // host prefix before deleting the DB row. Best-effort: failures are logged
    // internally and do not block the unpublish.
    await deletePageFromCustomHosts({ driveId: row.driveId, path: row.path, isHomePage });
    await db.delete(publishedPages).where(eq(publishedPages.pageId, pageId));

    // Rebuild the drive's sitemap so it no longer advertises the route we just
    // removed (and refresh robots/404 alongside it). Best-effort — the page is
    // already unpublished and the row deleted.
    await regeneratePublishedSiteFiles(row.driveId);

    auditRequest(req, {
      eventType: 'data.delete',
      userId,
      resourceType: 'page',
      resourceId: pageId,
      details: { operation: 'unpublish' },
    });

    return NextResponse.json({ unpublished: true });
  } catch (error) {
    loggers.api.error('Error unpublishing page:', error as Error);
    return NextResponse.json({ error: 'Failed to unpublish page' }, { status: 500 });
  }
}
