import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { hasFlyCertCredential } from '@/lib/fly/certs';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isCertEligible } from '@pagespace/lib/canvas/cert-action';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { reconcileCustomDomainCert } from '@/lib/canvas/reconcile-cert';

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

    // Same predicate the certs module uses, so a deployment carrying only
    // FLY_MACHINES_ORG_TOKEN is not told SSL is unconfigured when it is.
    if (!hasFlyCertCredential()) {
      loggers.api.error('No Fly API credential set — cert provisioning unavailable');
      return NextResponse.json(
        { error: 'SSL provisioning is not configured (ops: set FLY_API_TOKEN or FLY_MACHINES_ORG_TOKEN)' },
        { status: 503 },
      );
    }

    // Advance the cert one step via the shared service (also used by the lazy
    // reconcile on the domains-list GET). It commits the status, then runs the
    // active/cert_failed side effects best-effort.
    const { status: nextStatus, action, ownershipInstruction } = await reconcileCustomDomainCert({
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

    // `ownershipInstruction` is the actionable half of a cert that is stuck:
    // without it the UI can only say "still provisioning" for a hostname that
    // will never provision until the customer publishes a TXT record nobody has
    // told them about. Null whenever nothing is waiting on them.
    return NextResponse.json({ status: nextStatus, action, ownershipInstruction: ownershipInstruction ?? null });
  } catch (error) {
    loggers.api.error('Error refreshing cert:', error as Error);
    return NextResponse.json({ error: 'Failed to refresh cert' }, { status: 500 });
  }
}
