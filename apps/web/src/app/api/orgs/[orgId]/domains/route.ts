import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { addOrgDomain, listOrgDomains } from '@pagespace/lib/organizations/domains';
import { MAX_ORG_DOMAINS, dnsRecordName, dnsRecordValue } from '@pagespace/lib/organizations/domains-core';
import { authorizeOrgRequest, ORG_READ_AUTH, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { domainAddSchema } from '@/lib/orgs/org-schemas';

type Context = { params: Promise<{ orgId: string }> };

const DOMAIN_ERRORS = {
  invalid_domain: 'That is not a domain name. Enter it like northwind.com.',
  public_email_domain: 'A shared email provider cannot be verified for an organization.',
  already_added: 'This domain is already added to the organization.',
  claimed_by_another_org: 'Another organization has already verified this domain.',
  domain_limit_reached: `An organization can hold at most ${MAX_ORG_DOMAINS} domains. Remove one you no longer need first.`,
} as const;

/** The DNS record an Admin publishes for a claim, beside the claim itself. */
const withDnsRecord = <T extends { domain: string; dnsToken: string }>(claim: T) => ({
  ...claim,
  dnsRecord: { type: 'TXT' as const, name: dnsRecordName(claim.domain), value: dnsRecordValue(claim.dnsToken) },
});

/** GET /api/orgs/[orgId]/domains — the org's domain claims and their status (SEC-1); Owner and Admins. */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const domains = await listOrgDomains(orgId);
    auditRequest(request, { eventType: 'data.read', userId: gate.userId, resourceType: 'organization_domains', resourceId: orgId, details: { orgId, count: domains.length } });
    return NextResponse.json({ domains: domains.map(withDnsRecord) });
  } catch (error) {
    loggers.api.error('Error listing organization domains:', error as Error);
    return NextResponse.json({ error: 'Failed to list domains', code: 'internal_error' }, { status: 500 });
  }
}

/**
 * POST /api/orgs/[orgId]/domains — claim a domain (SEC-1); Owner and Admins. The claim is pending until
 * proven by DNS or a mailed link (POST .../[domainId]/verify). The add is audited in lib.
 */
export async function POST(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = domainAddSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues, code: 'invalid_request' }, { status: 400 });
    const result = await addOrgDomain({ orgId, domain: parsed.data.domain, actorId: gate.userId });
    if (!result.ok) return NextResponse.json({ error: DOMAIN_ERRORS[result.reason], code: result.reason }, { status: result.status });
    return NextResponse.json({ domain: withDnsRecord(result.domain) }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error adding organization domain:', error as Error);
    return NextResponse.json({ error: 'Failed to add domain', code: 'internal_error' }, { status: 500 });
  }
}
