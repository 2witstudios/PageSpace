import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { nextCertAction, certActionToDbStatus } from '@pagespace/lib/canvas/cert-action';
import type { CertEligibleStatus } from '@pagespace/lib/canvas/cert-action';
import { addCertificate } from '@/lib/fly/certs';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const FLY_APP_NAME = process.env.FLY_PROXY_APP_NAME ?? 'pagespace-proxy';

const CERT_ELIGIBLE: ReadonlySet<string> = new Set(['verified', 'provisioning', 'active']);

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

    if (!CERT_ELIGIBLE.has(domain.status)) {
      return NextResponse.json(
        { error: 'Domain must be DNS-verified before provisioning a cert (verify DNS first)' },
        { status: 409 },
      );
    }

    if (!process.env.FLY_API_TOKEN) {
      loggers.api.error('FLY_API_TOKEN not set — cert provisioning unavailable');
      return NextResponse.json({ error: 'SSL provisioning is not configured (ops: set FLY_API_TOKEN)' }, { status: 503 });
    }

    const flyCert = await addCertificate(FLY_APP_NAME, domain.hostname);

    const action = nextCertAction(domain.status as CertEligibleStatus, flyCert);
    const nextStatus = certActionToDbStatus(action);

    await db
      .update(customDomains)
      .set({ status: nextStatus })
      .where(eq(customDomains.id, domainId));

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: {
        operation: 'cert-refresh',
        hostname: domain.hostname,
        action: action.action,
        status: nextStatus,
      },
    });

    return NextResponse.json({ status: nextStatus, action: action.action });
  } catch (error) {
    loggers.api.error('Error refreshing cert:', error as Error);
    return NextResponse.json({ error: 'Failed to refresh cert' }, { status: 500 });
  }
}
