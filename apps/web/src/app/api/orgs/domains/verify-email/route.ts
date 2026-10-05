import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { confirmDomainProofEmail } from '@pagespace/lib/organizations/domains';
import { authenticateOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { domainProofConfirmSchema } from '@/lib/orgs/org-schemas';

const CONFIRM_ERRORS = {
  not_found: 'This verification link is not valid. It may already have been used.',
  link_expired: 'This verification link has expired. Ask the organization to send a new one.',
  proof_not_found: 'This verification link is no longer valid. Ask the organization to send a new one.',
  claimed_by_another_org: 'Another organization has already verified this domain.',
} as const;

/**
 * POST /api/orgs/domains/verify-email — confirm a mailed domain proof link (SEC-1). The token is the proof
 * that the person holds an administrative mailbox of the domain, so any signed-in account may confirm it;
 * that account is who the audit row names. Not an org member route: the confirmer is often IT, not a member.
 */
export async function POST(request: Request) {
  const gate = await authenticateOrgRequest(request, ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const limit = await checkDistributedRateLimit(`org_domain_confirm:${gate.userId}`, DISTRIBUTED_RATE_LIMITS.MAGIC_LINK);
    if (!limit.allowed) {
      return NextResponse.json({ error: 'Too many attempts. Please try again later.', code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 900) } });
    }
    const parsed = domainProofConfirmSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', code: 'invalid_request' }, { status: 400 });
    const result = await confirmDomainProofEmail({ token: parsed.data.token, actorId: gate.userId, now: new Date() });
    if (!result.ok) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: gate.userId, resourceType: 'org_domain', resourceId: 'email_proof', details: { reason: result.reason } });
      return NextResponse.json({ error: CONFIRM_ERRORS[result.reason], code: result.reason }, { status: result.status });
    }
    // Only the domain and its state: the confirmer may not be a member of the org that claimed it.
    return NextResponse.json({ domain: result.domain.domain, verified: true });
  } catch (error) {
    loggers.api.error('Error confirming domain verification link:', error as Error);
    return NextResponse.json({ error: 'Failed to verify domain', code: 'internal_error' }, { status: 500 });
  }
}
