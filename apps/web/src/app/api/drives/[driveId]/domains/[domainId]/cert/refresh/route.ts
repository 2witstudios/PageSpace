import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isCertEligible } from '@pagespace/lib/canvas/cert-action';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { reconcileCustomDomainCert } from '@/lib/canvas/reconcile-cert';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, checkMCPDriveScope } from '@/lib/auth/auth-core';
import { isPrincipalDriveOwnerOrAdmin } from '@/lib/auth/principal-permissions';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function POST(
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
      return NextResponse.json({ error: 'Only drive owners and admins can manage domain certs' }, { status: 403 });
    }

    const [domain] = await db
      .select()
      .from(customDomains)
      .where(and(eq(customDomains.id, domainId), eq(customDomains.driveId, driveId)));

    if (!domain) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
    }

    if (!isCertEligible(domain.status)) {
      return NextResponse.json(
        { error: 'Domain must be DNS-verified before provisioning a cert (verify DNS first)' },
        { status: 409 },
      );
    }

    if (!process.env.FLY_API_TOKEN) {
      loggers.api.error('FLY_API_TOKEN not set — cert provisioning unavailable');
      return NextResponse.json({ error: 'SSL provisioning is not configured (ops: set FLY_API_TOKEN)' }, { status: 503 });
    }

    // Advance the cert one step via the shared service (also used by the lazy
    // reconcile on the domains-list GET). It commits the status, then runs the
    // active/cert_failed side effects best-effort.
    const { status: nextStatus, action } = await reconcileCustomDomainCert({
      id: domain.id,
      driveId,
      hostname: domain.hostname,
      status: domain.status,
    });

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: {
        operation: 'cert-refresh',
        hostname: domain.hostname,
        action,
        status: nextStatus,
      },
    });

    return NextResponse.json({ status: nextStatus, action });
  } catch (error) {
    loggers.api.error('Error refreshing cert:', error as Error);
    return NextResponse.json({ error: 'Failed to refresh cert' }, { status: 500 });
  }
}
