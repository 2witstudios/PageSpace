import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalEditPage } from '@/lib/auth';
import { normalizeSubdomain, validatePublishSubdomain } from '@pagespace/lib/validators/subdomain';
import { slugify } from '@pagespace/lib/utils/utils';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { isHomeDrive, homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { renderPublishedPage } from '@/lib/canvas/render-published';
import { buildPublishedKey, putPublishedArtifact, deletePublishedArtifact, isPublishConfigured, getPublishAssetBaseUrl } from '@/lib/canvas/published-storage';
import { rewriteCanvasAssets } from '@/lib/canvas/asset-pipeline';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const PUBLISH_HOST = 'pagespace.site';

const publishSchema = z.object({
  subdomain: z.string().optional(),
  path: z.string().optional(),
}).nullable();

/** PostgreSQL unique_violation SQLSTATE. */
const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && (err as { code: string }).code === '23505';

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
    // Whether a publish attempt could actually succeed — used by the UI to hide the
    // Publish control instead of offering a button that only ever returns 503. This
    // must mirror EVERY 503 fast-path in POST below: the dedicated public bucket must
    // be configured AND the operational kill-switch must not be engaged.
    let available =
      isPublishConfigured() && process.env.CANVAS_PUBLISHING_DISABLED !== 'true';

    const row = await db.query.publishedPages.findFirst({
      where: eq(publishedPages.pageId, pageId),
      columns: { driveId: true, path: true, publishedAt: true, updatedAt: true },
    });

    if (!row) {
      // Home drive guard: suppress Publish button for pages inside a Home drive.
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
        columns: { publishSubdomain: true },
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

    return NextResponse.json({
      published: true,
      available,
      isStale,
      url: `https://${subdomain}.${PUBLISH_HOST}/${row.path}`,
      subdomain,
      path: row.path,
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

  // Operational kill-switch: lets operators disable publishing without a deploy.
  if (process.env.CANVAS_PUBLISHING_DISABLED === 'true') {
    return NextResponse.json({ error: 'Publishing is temporarily disabled' }, { status: 503 });
  }

  // Fail fast BEFORE any DB reservation: if the publish bucket isn't configured,
  // the later upload would throw and leave a published_pages row pointing at a
  // non-existent object. (Also makes publishing inert anywhere PUBLISH_BUCKET is
  // unset — e.g. a prod box that hasn't provisioned the public bucket yet.)
  if (!isPublishConfigured()) {
    return NextResponse.json({ error: 'Publishing is not configured' }, { status: 503 });
  }

  try {
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const parsedBody = publishSchema.parse(body);

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { id: true, type: true, title: true, content: true, driveId: true },
    });

    if (!page) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    if (page.type !== 'CANVAS') {
      return NextResponse.json({ error: 'Only canvas pages can be published' }, { status: 400 });
    }

    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, page.driveId),
      columns: { id: true, slug: true, publishSubdomain: true, kind: true },
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (isHomeDrive(drive)) {
      return NextResponse.json({ error: homeDriveActionError(drive, 'publish') }, { status: 403 });
    }

    // Resolve the drive's publish subdomain: reuse if already allocated,
    // otherwise validate + allocate the requested (or slug-derived) candidate.
    let subdomain = drive.publishSubdomain;
    if (!subdomain) {
      const candidate = normalizeSubdomain(parsedBody?.subdomain ?? drive.slug);
      const validation = validatePublishSubdomain(candidate);
      if (!validation.valid) {
        return NextResponse.json({ error: validation.reason }, { status: 400 });
      }

      try {
        await db.update(drives).set({ publishSubdomain: candidate }).where(eq(drives.id, drive.id));
      } catch (err) {
        if (isUniqueViolation(err)) {
          return NextResponse.json({ error: 'Subdomain taken, choose another' }, { status: 409 });
        }
        throw err;
      }
      subdomain = candidate;
    }

    // Resolve a safe path: caller-supplied path, else a slug of the title,
    // falling back to the page id when the slug is empty.
    const rawPath = parsedBody?.path ?? page.title ?? '';
    const path = slugify(rawPath) || pageId;

    const { html: rewrittenHtml } = await rewriteCanvasAssets({ html: page.content ?? '', userId, db });
    const assetBaseUrl = getPublishAssetBaseUrl();
    const html = renderPublishedPage({ html: rewrittenHtml, title: page.title ?? undefined, assetBaseUrl });
    const key = buildPublishedKey(subdomain, path);

    // Capture the artifact this page currently points at, so we can clean it up
    // below if the resolved key changed (e.g. the title/path changed).
    const existing = await db.query.publishedPages.findFirst({
      where: eq(publishedPages.pageId, pageId),
      columns: { artifactKey: true },
    });

    // Reserve the (driveId, path) slot in the DB BEFORE writing storage. The unique
    // constraint on (driveId, path) rejects a page whose resolved path is already
    // owned by another page, so a colliding publish can never overwrite another
    // page's already-published artifact at the shared key.
    // updatedAt is intentionally NOT advanced here on conflict — it is updated only
    // after the artifact write succeeds, so a failed upload never falsely clears
    // the stale indicator on the next GET.
    try {
      await db
        .insert(publishedPages)
        .values({
          driveId: page.driveId,
          pageId,
          path,
          artifactKey: key,
          publishedBy: userId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: publishedPages.pageId,
          set: {
            path,
            artifactKey: key,
            publishedBy: userId,
          },
        });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return NextResponse.json({ error: 'Another page is already published at that path; choose a different path' }, { status: 409 });
      }
      throw err;
    }

    // The path is now reserved for this page — safe to write the artifact.
    await putPublishedArtifact({ subdomain, path, html });

    // Advance updatedAt only after the artifact is successfully written. This
    // ensures GET /publish reports isStale: true if a prior upload attempt failed.
    await db
      .update(publishedPages)
      .set({ updatedAt: new Date() })
      .where(eq(publishedPages.pageId, pageId));

    // Remove the previous artifact when the key changed, so a stale URL is not left
    // publicly servable after a rename/republish.
    if (existing?.artifactKey && existing.artifactKey !== key) {
      try {
        await deletePublishedArtifact(existing.artifactKey);
      } catch (cleanupError) {
        loggers.api.warn('Failed to delete stale published artifact', { artifactKey: existing.artifactKey, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
      }
    }

    auditRequest(req, {
      eventType: 'data.write',
      userId,
      resourceType: 'page',
      resourceId: pageId,
      details: { operation: 'publish' },
    });

    return NextResponse.json({
      url: `https://${subdomain}.${PUBLISH_HOST}/${path}`,
      subdomain,
      path,
    });
  } catch (error) {
    loggers.api.error('Error publishing page:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to publish page' }, { status: 500 });
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
      columns: { id: true, artifactKey: true },
    });

    if (!row) {
      return NextResponse.json({ error: 'Page is not published' }, { status: 404 });
    }

    await deletePublishedArtifact(row.artifactKey);
    await db.delete(publishedPages).where(eq(publishedPages.pageId, pageId));

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
