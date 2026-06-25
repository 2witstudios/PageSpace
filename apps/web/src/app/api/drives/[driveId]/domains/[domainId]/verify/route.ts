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
import { mirrorDriveToCustomHost, clearCustomHost } from '@/lib/canvas/custom-domain-mirror';

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

    const nextStatus = result.verified ? 'verified' : 'dns_failed';
    await db
      .update(customDomains)
      .set({ status: nextStatus })
      .where(eq(customDomains.id, domainId));

    // Content mirroring is decoupled from cert activation: the moment DNS is
    // confirmed, mirror the drive's published artifacts to `published/<host>/`
    // so the custom-domain prefix is populated immediately — serving no longer
    // waits on the async Fly cert. When DNS breaks, clear the prefix so stale
    // content stops being served. Both best-effort and fire-and-forget: a
    // storage failure must never fail the verify response.
    if (nextStatus === 'verified') {
      mirrorDriveToCustomHost(driveId, domain.hostname).catch((err) => {
        loggers.api.warn('Failed to mirror drive to custom host on verify', {
          driveId,
          hostname: domain.hostname,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      clearCustomHost(domain.hostname).catch((err) => {
        loggers.api.warn('Failed to clear custom host on DNS failure', {
          hostname: domain.hostname,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

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
