import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { normalizeSubdomain, validatePublishSubdomain } from '@pagespace/lib/validators/subdomain';
import { slugify } from '@pagespace/lib/utils/utils';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { renderPublishedPage } from '@/lib/canvas/render-published';
import { putPublishedArtifact, deletePublishedArtifact } from '@/lib/canvas/published-storage';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const PUBLISH_HOST = 'pagespace.site';

const publishSchema = z.object({
  subdomain: z.string().optional(),
  path: z.string().optional(),
}).nullable();

/** PostgreSQL unique_violation SQLSTATE. */
const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && (err as { code: string }).code === '23505';

export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to publish this page' }, { status: 403 });
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
      columns: { id: true, slug: true, publishSubdomain: true },
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
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

    const html = renderPublishedPage({ html: page.content ?? '', title: page.title ?? undefined });

    const { key } = await putPublishedArtifact({ subdomain, path, html });

    await db
      .insert(publishedPages)
      .values({
        driveId: page.driveId,
        pageId,
        path,
        artifactKey: key,
        publishedBy: userId,
      })
      .onConflictDoUpdate({
        target: publishedPages.pageId,
        set: {
          path,
          artifactKey: key,
          publishedBy: userId,
          updatedAt: new Date(),
        },
      });

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

  const canEdit = await canUserEditPage(userId, pageId);
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
