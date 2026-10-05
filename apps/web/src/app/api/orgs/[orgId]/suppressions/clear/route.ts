import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { clearDepartureSuppression } from '@pagespace/lib/organizations/departure-suppression';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { suppressionClearSchema } from '@/lib/orgs/org-schemas';

type Context = { params: Promise<{ orgId: string }> };

/**
 * POST /api/orgs/[orgId]/suppressions/clear — [D-OW-27] an Owner or Admin lets a departed member's address be
 * auto-joined again by a verified domain. The org keeps only a keyed hash of that address, so the Admin types
 * it; the answer is only whether a record was cleared, and the address is never stored, logged or echoed.
 * Scoped to the org in the path. The clear is audited in lib (org.member.suppression_cleared).
 */
export async function POST(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const limit = await checkDistributedRateLimit(`org_suppression_clear:${orgId}:${gate.userId}`, DISTRIBUTED_RATE_LIMITS.API);
    if (!limit.allowed) {
      return NextResponse.json({ error: 'Too many requests. Please try again later.', code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 60) } });
    }
    const parsed = suppressionClearSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', code: 'invalid_request' }, { status: 400 });
    const cleared = await clearDepartureSuppression({ orgId, email: parsed.data.email, actorId: gate.userId });
    auditRequest(request, { eventType: 'data.delete', userId: gate.userId, resourceType: 'org_departure_suppression', resourceId: orgId, details: { orgId, cleared } });
    return NextResponse.json({ cleared });
  } catch (error) {
    loggers.api.error('Error clearing a departure suppression:', error as Error);
    return NextResponse.json({ error: 'Failed to clear the suppression', code: 'internal_error' }, { status: 500 });
  }
}
