import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { sendDomainProofEmail, verifyOrgDomainByDns } from '@pagespace/lib/organizations/domains';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { domainVerifySchema } from '@/lib/orgs/org-schemas';
import { deliverDomainProof } from '@/lib/orgs/org-domain-delivery';

type Context = { params: Promise<{ orgId: string; domainId: string }> };

const VERIFY_ERRORS = {
  not_found: 'Domain not found',
  proof_not_found: 'The verification TXT record was not found yet. DNS changes can take a while to appear; try again shortly.',
  link_expired: 'The verification link has expired. Send a new one.',
  claimed_by_another_org: 'Another organization has already verified this domain.',
  already_verified: 'This domain is already verified.',
} as const;

const tooMany = (retryAfter: number | undefined) =>
  NextResponse.json({ error: 'Too many verification attempts. Please try again later.' }, { status: 429, headers: { 'Retry-After': String(retryAfter ?? 900) } });

/**
 * POST /api/orgs/[orgId]/domains/[domainId]/verify — prove control of a claimed domain (SEC-1); Owner and
 * Admins. `{ method: 'dns' }` checks the claim's TXT record now; `{ method: 'email', mailbox }` mails a
 * one-use link to that administrative mailbox of the domain (admin@, postmaster@, …), and the domain is
 * verified when the link is confirmed. Verification and sends are audited in lib.
 */
export async function POST(request: Request, context: Context) {
  const { orgId, domainId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = domainVerifySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 });

    if (parsed.data.method === 'dns') {
      const limit = await checkDistributedRateLimit(`org_domain_dns:${orgId}`, DISTRIBUTED_RATE_LIMITS.API);
      if (!limit.allowed) return tooMany(limit.retryAfter);
      const result = await verifyOrgDomainByDns({ orgId, domainId, actorId: gate.userId, now: new Date() });
      if (!result.ok) {
        // A refused proof is a forensic fact: someone tried to take a domain.
        auditRequest(request, { eventType: 'authz.access.denied', userId: gate.userId, resourceType: 'org_domain', resourceId: domainId, details: { orgId, method: 'dns', reason: result.reason } });
        return NextResponse.json({ error: VERIFY_ERRORS[result.reason], reason: result.reason }, { status: result.status });
      }
      return NextResponse.json({ domain: result.domain, alreadyVerified: result.alreadyVerified });
    }

    // Mail to a third party's mailbox: a few per claim per hour, so the route cannot be used to spam it.
    const limit = await checkDistributedRateLimit(`org_domain_email:${domainId}`, DISTRIBUTED_RATE_LIMITS.EMAIL_RESEND);
    if (!limit.allowed) return tooMany(limit.retryAfter);
    const sent = await sendDomainProofEmail({
      orgId,
      domainId,
      mailbox: parsed.data.mailbox,
      actorId: gate.userId,
      now: new Date(),
      deliver: ({ to, domain, token }) => deliverDomainProof({ orgId, to, domain, token }),
    });
    if (!sent.ok) {
      if (sent.reason === 'delivery_failed') {
        loggers.api.error('Failed to send domain verification email', sent.cause as Error, { orgId });
        return NextResponse.json({ error: 'Failed to send the verification email' }, { status: 502 });
      }
      auditRequest(request, { eventType: 'authz.access.denied', userId: gate.userId, resourceType: 'org_domain', resourceId: domainId, details: { orgId, method: 'email', reason: sent.reason } });
      return NextResponse.json({ error: VERIFY_ERRORS[sent.reason], reason: sent.reason }, { status: sent.status });
    }
    return NextResponse.json({ sentTo: sent.sentTo, expiresAt: sent.expiresAt }, { status: 202 });
  } catch (error) {
    loggers.api.error('Error verifying organization domain:', error as Error);
    return NextResponse.json({ error: 'Failed to verify domain' }, { status: 500 });
  }
}
