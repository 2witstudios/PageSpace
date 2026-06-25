import { NextResponse } from 'next/server';
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
import { isServingStatus } from '@pagespace/lib/canvas/cert-action';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

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
