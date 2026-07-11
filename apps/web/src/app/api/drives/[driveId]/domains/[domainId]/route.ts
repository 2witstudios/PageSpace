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
import { clearCustomHost, mirrorDriveToCustomHost } from '@/lib/canvas/custom-domain-mirror';
import { regeneratePublishedSiteFiles, republishDriveCanonical, renderDomainNotFoundOverride } from '@/lib/canvas/publish-page';
import { isServingStatus } from '@pagespace/lib/canvas/cert-action';
import { isValidDriveNotFoundPage } from '@pagespace/lib/services/drive-service';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const patchDomainSchema = z
  .object({
    isPrimary: z.literal(true).optional(),
    // Per-domain overrides of this domain's published root ('/') and 404 page
    // — see custom_domains.publishLandingPageId/publishNotFoundPageId. min(1):
    // "" must never reach the FK; null is the only clear "unset" signal.
    publishLandingPageId: z.string().min(1).nullable().optional(),
    publishNotFoundPageId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.isPrimary !== undefined ||
      data.publishLandingPageId !== undefined ||
      data.publishNotFoundPageId !== undefined,
    { message: 'At least one field must be provided' },
  );

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

    let updated: typeof customDomains.$inferSelect | undefined;

    // Validate the ENTIRE payload before any mutation runs. A mixed payload
    // (e.g. isPrimary + an invalid publishLandingPageId) must not partially
    // apply — checking each field only inside its own mutation block let the
    // isPrimary change commit before the landing-page validation could reject
    // the request, so a 400 response could still carry a real, persisted
    // primary-domain change.
    if (body.data.isPrimary && target.status !== 'active') {
      return NextResponse.json({ error: 'Only an active domain can be set as primary' }, { status: 400 });
    }
    // Same gate as the drive-wide 404 page (packages/lib/src/services/drive-service.ts):
    // must exist, belong to this drive, be non-trashed, and be a CANVAS page —
    // the override is rendered through the canvas publish pipeline like the
    // drive-wide default it's overriding.
    if (typeof body.data.publishLandingPageId === 'string') {
      if (!(await isValidDriveNotFoundPage(driveId, body.data.publishLandingPageId))) {
        return NextResponse.json(
          { error: 'Landing page must be a non-trashed Canvas page in this drive' },
          { status: 400 },
        );
      }
    }
    if (typeof body.data.publishNotFoundPageId === 'string') {
      if (!(await isValidDriveNotFoundPage(driveId, body.data.publishNotFoundPageId))) {
        return NextResponse.json(
          { error: '404 page must be a non-trashed Canvas page in this drive' },
          { status: 400 },
        );
      }
    }

    if (body.data.isPrimary) {
      // Clear-then-set in a transaction so the drive always has exactly one primary
      // (also guarded by the partial unique index custom_domains_primary_per_drive).
      [updated] = await db.transaction(async (tx) => {
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
      // artifact points at the NEW primary host. Each re-publish also regenerates
      // the drive's sitemap/robots, so only refresh those separately when nothing
      // was re-rendered (a drive with no published pages still needs its crawl
      // files pointed at the new primary). Awaited so the published site is
      // consistent before we report success. Best-effort by contract (these log
      // and swallow failures); the try/catch is a final guard so a storage hiccup
      // never fails the primary change itself — the DB update has already
      // committed and the next publish re-bakes anything that lagged.
      try {
        const refreshed = await republishDriveCanonical(driveId, auth.userId);
        if (refreshed === 0) {
          await regeneratePublishedSiteFiles(driveId);
        }
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
    }

    if (body.data.publishLandingPageId !== undefined || body.data.publishNotFoundPageId !== undefined) {
      [updated] = await db
        .update(customDomains)
        .set({
          ...(body.data.publishLandingPageId !== undefined && { publishLandingPageId: body.data.publishLandingPageId }),
          ...(body.data.publishNotFoundPageId !== undefined && { publishNotFoundPageId: body.data.publishNotFoundPageId }),
        })
        .where(and(eq(customDomains.id, domainId), eq(customDomains.driveId, driveId)))
        .returning();

      // Re-mirror just this host so the new override (or its clearing) takes
      // effect immediately rather than waiting on the next unrelated publish.
      // Awaited (like the isPrimary re-render above) so the response reflects
      // reality — the domain is actually serving the new override, or the
      // drive default it fell back to, before we report success. Best-effort
      // by contract: a storage hiccup here is logged and swallowed rather
      // than failing the request — the DB update already committed either
      // way, and the next unrelated publish/backfill re-resolves it.
      try {
        await mirrorDriveToCustomHost(driveId, target.hostname, renderDomainNotFoundOverride);
      } catch (err) {
        loggers.api.warn('Failed to re-mirror host after landing/404 override change', {
          driveId,
          hostname: target.hostname,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      auditRequest(request, {
        eventType: 'data.write',
        userId: auth.userId,
        resourceType: 'drive',
        resourceId: driveId,
        details: {
          operation: 'set-custom-domain-page-overrides',
          hostname: target.hostname,
          publishLandingPageId: body.data.publishLandingPageId,
          publishNotFoundPageId: body.data.publishNotFoundPageId,
        },
      });
    }

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
    // served if the domain is re-added later or pointed elsewhere. Keyed off the
    // serving predicate (verified | provisioning | active) — content is mirrored
    // at verify time, so a verified/provisioning domain removed before SSL goes
    // active still has a populated prefix that must be cleared. Best-effort: a
    // storage failure does not block the successful domain removal.
    if (isServingStatus(deleted.status)) {
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
