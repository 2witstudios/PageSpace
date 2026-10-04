/**
 * /api/orgs/[orgId]/domains and /api/orgs/domains/verify-email (Spec SEC-1). The domain service is faked;
 * authorization is NOT: the real requireOrgRole runs over a faked membership lookup, so a route that
 * skipped it or asked for the wrong role fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: { API: 'API', EMAIL_RESEND: 'EMAIL_RESEND', MAGIC_LINK: 'MAGIC_LINK' },
}));
vi.mock('@pagespace/lib/organizations/domains', () => ({
  addOrgDomain: vi.fn(),
  listOrgDomains: vi.fn(),
  removeOrgDomain: vi.fn(),
  verifyOrgDomainByDns: vi.fn(),
  sendDomainProofEmail: vi.fn(),
  confirmDomainProofEmail: vi.fn(),
}));
vi.mock('@/lib/orgs/org-domain-delivery', () => ({ deliverDomainProof: vi.fn() }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import {
  addOrgDomain,
  confirmDomainProofEmail,
  listOrgDomains,
  removeOrgDomain,
  sendDomainProofEmail,
  verifyOrgDomainByDns,
} from '@pagespace/lib/organizations/domains';
import { deliverDomainProof } from '@/lib/orgs/org-domain-delivery';
import { GET, POST } from '../route';
import { DELETE } from '../[domainId]/route';
import { POST as VERIFY } from '../[domainId]/verify/route';
import { POST as CONFIRM } from '../../../domains/verify-email/route';

const ORG_ID = 'org_northwind';
const DOMAIN_ID = 'dom_1';
const session = (userId: string): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0 });
const ctx = { params: Promise.resolve({ orgId: ORG_ID }) };
const domainCtx = { params: Promise.resolve({ orgId: ORG_ID, domainId: DOMAIN_ID }) };
const req = (method: string, body?: unknown) =>
  new Request(`https://example.test/api/orgs/${ORG_ID}/domains`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const as = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);

const claim = {
  id: DOMAIN_ID,
  orgId: ORG_ID,
  domain: 'northwind.com',
  dnsToken: 'tok123',
  emailTokenExpiresAt: null,
  emailSentTo: null,
  verifiedAt: null,
  verifiedMethod: null,
  createdBy: 'user_priya',
  createdAt: new Date('2026-10-01T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  flags.orgsEnabled = true;
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_priya'));
  vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
  vi.mocked(listOrgDomains).mockResolvedValue([claim]);
  vi.mocked(addOrgDomain).mockResolvedValue({ ok: true, domain: claim });
  vi.mocked(removeOrgDomain).mockResolvedValue(true);
  vi.mocked(verifyOrgDomainByDns).mockResolvedValue({ ok: true, domain: { ...claim, verifiedAt: new Date(), verifiedMethod: 'dns' }, alreadyVerified: false });
  vi.mocked(sendDomainProofEmail).mockResolvedValue({ ok: true, sentTo: 'postmaster@northwind.com', expiresAt: new Date() });
  vi.mocked(confirmDomainProofEmail).mockResolvedValue({ ok: true, domain: { ...claim, verifiedAt: new Date(), verifiedMethod: 'email' }, alreadyVerified: false });
});

describe('domain routes', () => {
  it('SEC-1 (partial) only Owner and Admins see or change domains; a plain member is refused and a non-member sees no org', async () => {
    as('MEMBER');
    expect((await GET(req('GET'), ctx)).status).toBe(403);
    expect((await POST(req('POST', { domain: 'northwind.com' }), ctx)).status).toBe(403);
    expect((await DELETE(req('DELETE'), domainCtx)).status).toBe(403);
    expect((await VERIFY(req('POST', { method: 'dns' }), domainCtx)).status).toBe(403);
    as(null);
    expect((await GET(req('GET'), ctx)).status).toBe(404);
    expect((await POST(req('POST', { domain: 'northwind.com' }), ctx)).status).toBe(404);
    expect((await VERIFY(req('POST', { method: 'dns' }), domainCtx)).status).toBe(404);
    for (const fn of [listOrgDomains, addOrgDomain, removeOrgDomain, verifyOrgDomainByDns, sendDomainProofEmail]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('SEC-1 (partial) dark while ORGS_ENABLED is off: every domain route answers 404, the confirm link too', async () => {
    flags.orgsEnabled = false;
    as('OWNER');
    expect((await GET(req('GET'), ctx)).status).toBe(404);
    expect((await CONFIRM(req('POST', { token: 't' }))).status).toBe(404);
    expect(confirmDomainProofEmail).not.toHaveBeenCalled();
  });

  it('SEC-1 (partial) an Admin claims a domain and is shown the exact TXT record to publish', async () => {
    as('ADMIN');
    const res = await POST(req('POST', { domain: 'NorthWind.com' }), ctx);
    expect(res.status).toBe(201);
    expect(addOrgDomain).toHaveBeenCalledWith({ orgId: ORG_ID, domain: 'NorthWind.com', actorId: 'user_priya' });
    const body = await res.json();
    expect(body.domain.dnsRecord).toEqual({ type: 'TXT', name: '_pagespace-verification.northwind.com', value: 'pagespace-domain-verification=tok123' });
  });

  it('SEC-1 (partial) refusals carry their status: a shared provider 400, a domain another org holds 409', async () => {
    as('OWNER');
    vi.mocked(addOrgDomain).mockResolvedValueOnce({ ok: false, status: 400, reason: 'public_email_domain' });
    expect((await POST(req('POST', { domain: 'gmail.com' }), ctx)).status).toBe(400);
    vi.mocked(addOrgDomain).mockResolvedValueOnce({ ok: false, status: 409, reason: 'claimed_by_another_org' });
    const res = await POST(req('POST', { domain: 'northwind.com' }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('claimed_by_another_org');
  });

  it('SEC-1 (partial) DNS verification runs for the caller\'s org and the claim in the path, never another org\'s', async () => {
    as('ADMIN');
    expect((await VERIFY(req('POST', { method: 'dns' }), domainCtx)).status).toBe(200);
    expect(verifyOrgDomainByDns).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID, domainId: DOMAIN_ID, actorId: 'user_priya' }));
    vi.mocked(verifyOrgDomainByDns).mockResolvedValueOnce({ ok: false, status: 422, reason: 'proof_not_found' });
    expect((await VERIFY(req('POST', { method: 'dns' }), domainCtx)).status).toBe(422);
  });

  it('SEC-1 (partial) the email method mails only an administrative mailbox, rate limited per claim', async () => {
    as('ADMIN');
    expect((await VERIFY(req('POST', { method: 'email', mailbox: 'jono' }), domainCtx)).status).toBe(400);
    const res = await VERIFY(req('POST', { method: 'email', mailbox: 'postmaster' }), domainCtx);
    expect(res.status).toBe(202);
    expect(sendDomainProofEmail).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID, domainId: DOMAIN_ID, mailbox: 'postmaster' }));
    expect(checkDistributedRateLimit).toHaveBeenCalledWith(`org_domain_email:${DOMAIN_ID}`, 'EMAIL_RESEND');
    // The delivery the service is handed sends through the web mailer for this org.
    const { deliver } = vi.mocked(sendDomainProofEmail).mock.calls[0][0];
    await deliver({ to: 'postmaster@northwind.com', domain: 'northwind.com', token: 't', expiresAt: new Date() });
    expect(deliverDomainProof).toHaveBeenCalledWith({ orgId: ORG_ID, to: 'postmaster@northwind.com', domain: 'northwind.com', token: 't' });

    vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 60 });
    expect((await VERIFY(req('POST', { method: 'email', mailbox: 'admin' }), domainCtx)).status).toBe(429);
  });

  it('SEC-1 (partial) removing a claim is scoped to the org in the path; an unknown claim is 404', async () => {
    as('OWNER');
    expect((await DELETE(req('DELETE'), domainCtx)).status).toBe(200);
    expect(removeOrgDomain).toHaveBeenCalledWith({ orgId: ORG_ID, domainId: DOMAIN_ID, actorId: 'user_priya' });
    vi.mocked(removeOrgDomain).mockResolvedValueOnce(false);
    expect((await DELETE(req('DELETE'), domainCtx)).status).toBe(404);
  });

  it('SEC-1 (partial) the mailed link is confirmed by a signed-in account, which the service records, and reveals only the domain', async () => {
    const res = await CONFIRM(req('POST', { token: 'ps_orgdom_abc' }));
    expect(res.status).toBe(200);
    expect(confirmDomainProofEmail).toHaveBeenCalledWith(expect.objectContaining({ token: 'ps_orgdom_abc', actorId: 'user_priya' }));
    expect(await res.json()).toEqual({ domain: 'northwind.com', verified: true });

    vi.mocked(confirmDomainProofEmail).mockResolvedValueOnce({ ok: false, status: 422, reason: 'link_expired' });
    expect((await CONFIRM(req('POST', { token: 'old' }))).status).toBe(422);

    vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await CONFIRM(req('POST', { token: 'x' }))).status).toBe(401);
  });
});
