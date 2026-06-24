import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { buildDnsInstructions, verifyDnsRecords } from '@pagespace/lib/validators/custom-domain';
import { resolveHostname } from '@/lib/publish/dns-resolver';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const EDGE_IPV4 = process.env.PUBLISH_EDGE_IPV4 ?? '';
const EDGE_IPV6 = process.env.PUBLISH_EDGE_IPV6 ?? '';
const CNAME_TARGET = process.env.PUBLISH_EDGE_CNAME_TARGET ?? '';

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
      return NextResponse.json({ error: 'Only drive owners and admins can verify custom domains' }, { status: 403 });
    }

    const [domain] = await db
      .select()
      .from(customDomains)
      .where(and(eq(customDomains.id, domainId), eq(customDomains.driveId, driveId)));

    if (!domain) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
    }

    const expected = buildDnsInstructions({
      hostname: domain.hostname,
      edgeIpv4: EDGE_IPV4,
      edgeIpv6: EDGE_IPV6,
      cnameTarget: CNAME_TARGET,
    });

    const resolved = await resolveHostname(domain.hostname);
    const result = verifyDnsRecords({ hostname: domain.hostname, expected, resolved });

    const nextStatus = result.verified ? 'verified' : 'failed';
    await db
      .update(customDomains)
      .set({ status: nextStatus })
      .where(eq(customDomains.id, domainId));

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { operation: 'verify-custom-domain', hostname: domain.hostname, status: nextStatus },
    });

    return NextResponse.json({ verified: result.verified, status: nextStatus, reason: result.reason });
  } catch (error) {
    loggers.api.error('Error verifying custom domain:', error as Error);
    return NextResponse.json({ error: 'Failed to verify domain' }, { status: 500 });
  }
}
