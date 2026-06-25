import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { clearCustomHost } from '@/lib/canvas/custom-domain-mirror';
import { regeneratePublishedSiteFiles, republishDriveCanonical } from '@/lib/canvas/publish-page';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const patchDomainSchema = z.object({
  isPrimary: z.literal(true),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ driveId: string; domainId: string }> },
) {
  try {
    const { driveId, domainId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
      return NextResponse.json({ error: 'Only drive owners and admins can change the primary domain' }, { status: 403 });
    }

    let requestBody: unknown;
    try {
      requestBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const body = patchDomainSchema.safeParse(requestBody);
    if (!body.success) {
      return NextResponse.json({ error: 'Invalid request body', details: body.error.issues }, { status: 400 });
    }

    const target = await db.query.customDomains.findFirst({
      where: and(eq(customDomains.id, domainId), eq(customDomains.driveId, driveId)),
      columns: { id: true, hostname: true, status: true },
    });

    if (!target) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
    }

    // Only a live host can be primary — the primary domain is the canonical SEO
    // host and the link shown on published pages, so it must actually serve.
    if (target.status !== 'active') {
      return NextResponse.json({ error: 'Only an active domain can be set as primary' }, { status: 400 });
    }

    // Clear-then-set in a transaction so the drive always has exactly one primary
    // (also guarded by the partial unique index custom_domains_primary_per_drive).
    const [updated] = await db.transaction(async (tx) => {
      await tx
        .update(customDomains)
        .set({ isPrimary: false })
        .where(and(eq(customDomains.driveId, driveId), eq(customDomains.isPrimary, true)));

      return tx
        .update(customDomains)
        .set({ isPrimary: true })
        .where(and(eq(customDomains.id, domainId), eq(customDomains.driveId, driveId)))
        .returning();
    });

    // Re-render every published page so the canonical/og:url baked into each
    // artifact points at the NEW primary host, then refresh the drive's
    // sitemap/robots. Awaited so the published site is consistent before we
    // report success. Both calls are best-effort by contract (they log and
    // swallow failures); the try/catch is a final guard so a storage hiccup
    // never fails the primary change itself — the DB update has already
    // committed and the next publish re-bakes anything that lagged.
    try {
      await republishDriveCanonical(driveId, auth.userId);
      await regeneratePublishedSiteFiles(driveId);
    } catch (err) {
      loggers.api.warn('Failed to refresh published pages after primary domain change', {
        driveId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { operation: 'set-primary-custom-domain', hostname: target.hostname },
    });

    return NextResponse.json({ domain: updated });
  } catch (error) {
    loggers.api.error('Error setting primary custom domain:', error as Error);
    return NextResponse.json({ error: 'Failed to set primary domain' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ driveId: string; domainId: string }> },
) {
  try {
    const { driveId, domainId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
      return NextResponse.json({ error: 'Only drive owners and admins can remove custom domains' }, { status: 403 });
    }

    const [deleted] = await db
      .delete(customDomains)
      .where(and(eq(customDomains.id, domainId), eq(customDomains.driveId, driveId)))
      .returning();

    if (!deleted) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
    }

    // Wipe all artifacts under this host's prefix so stale content is not
    // served if the domain is re-added later or pointed elsewhere. Best-effort:
    // a storage failure does not block the successful domain removal.
    if (deleted.status === 'active') {
      clearCustomHost(deleted.hostname).catch((err) => {
        loggers.api.warn('Failed to clear custom host artifacts after domain removal', {
          hostname: deleted.hostname,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    auditRequest(request, {
      eventType: 'data.delete',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { operation: 'remove-custom-domain', hostname: deleted.hostname },
    });

    return NextResponse.json({ deleted: true });
  } catch (error) {
    loggers.api.error('Error removing custom domain:', error as Error);
    return NextResponse.json({ error: 'Failed to remove domain' }, { status: 500 });
  }
}
