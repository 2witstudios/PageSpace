import { describe, it, expect } from 'vitest';
import {
  DOMAIN_ADMIN_MAILBOXES,
  DOMAIN_TXT_PREFIX,
  decideAutoJoin,
  decideDomainVerification,
  dnsRecordName,
  dnsRecordValue,
  emailDomain,
  isAdminMailboxAddress,
  normalizeDomain,
  txtRecordsProve,
} from '../domains-core';

const T0 = new Date('2026-10-01T00:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('normalizeDomain', () => {
  it('SEC-1 (partial) lowercases, trims and drops a trailing dot so one domain has one spelling', () => {
    expect(normalizeDomain('  NorthWind.COM. ')).toEqual({ ok: true, domain: 'northwind.com' });
  });

  it('SEC-1 (partial) stores an internationalized domain as punycode', () => {
    expect(normalizeDomain('bücher.de')).toEqual({ ok: true, domain: 'xn--bcher-kva.de' });
  });

  it.each([
    ['', 'empty'],
    ['northwind', 'single label'],
    ['@northwind.com', 'an address fragment'],
    ['bob@northwind.com', 'an address'],
    ['https://northwind.com', 'a URL'],
    ['northwind.com/path', 'a path'],
    ['192.168.1.10', 'an IP literal'],
    ['-bad.com', 'a label starting with a hyphen'],
    ['bad-.com', 'a label ending with a hyphen'],
    ['a..com', 'an empty label'],
    [`${'a'.repeat(64)}.com`, 'a label over 63 characters'],
    ['*.northwind.com', 'a wildcard'],
  ])('SEC-1 (partial) refuses %j (%s)', (input) => {
    expect(normalizeDomain(input)).toEqual({ ok: false, reason: 'invalid_domain' });
  });

  it('SEC-1 (partial) refuses a shared mailbox provider: verifying gmail.com would auto-join strangers', () => {
    expect(normalizeDomain('GMail.com')).toEqual({ ok: false, reason: 'public_email_domain' });
    expect(normalizeDomain('outlook.com')).toEqual({ ok: false, reason: 'public_email_domain' });
  });
});

describe('emailDomain', () => {
  it('SEC-1 (partial) is the normalized part after the last @, and null for anything that is not an address', () => {
    expect(emailDomain('Lena.Schulz@NorthWind.com')).toBe('northwind.com');
    expect(emailDomain('no-at-sign')).toBeNull();
    expect(emailDomain('x@localhost')).toBeNull();
  });

  it('SEC-1 (partial) matches the exact domain only: a subdomain address is not on the parent domain', () => {
    expect(emailDomain('a@eng.northwind.com')).toBe('eng.northwind.com');
  });
});

describe('DNS proof', () => {
  it('SEC-1 (partial) the record lives under a prefixed name and carries the claim token', () => {
    expect(dnsRecordName('northwind.com')).toBe(`${DOMAIN_TXT_PREFIX}.northwind.com`);
    expect(dnsRecordValue('tok123')).toBe('pagespace-domain-verification=tok123');
  });

  it('SEC-1 (partial) proves control only with an exact record, joining the chunks DNS splits a long TXT into', () => {
    expect(txtRecordsProve([['pagespace-domain-verification=tok123']], 'tok123')).toBe(true);
    expect(txtRecordsProve([['pagespace-domain-', 'verification=tok123']], 'tok123')).toBe(true);
    expect(txtRecordsProve([['v=spf1 -all'], [' pagespace-domain-verification=tok123 ']], 'tok123')).toBe(true);
  });

  it('SEC-1 (partial) another org\'s token, a prefix of the token, or no record proves nothing', () => {
    expect(txtRecordsProve([['pagespace-domain-verification=other']], 'tok123')).toBe(false);
    expect(txtRecordsProve([['pagespace-domain-verification=tok1234']], 'tok123')).toBe(false);
    expect(txtRecordsProve([['pagespace-domain-verification=tok12']], 'tok123')).toBe(false);
    expect(txtRecordsProve([], 'tok123')).toBe(false);
    expect(txtRecordsProve([['pagespace-domain-verification=']], '')).toBe(false);
  });
});

describe('admin mailboxes', () => {
  it('SEC-1 (partial) only the domain\'s administrative mailboxes can receive the proof link, never an arbitrary member address', () => {
    expect(DOMAIN_ADMIN_MAILBOXES).toEqual(['admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster']);
    expect(isAdminMailboxAddress('postmaster@northwind.com', 'northwind.com')).toBe(true);
    expect(isAdminMailboxAddress('Admin@NorthWind.com', 'northwind.com')).toBe(true);
    expect(isAdminMailboxAddress('jono@northwind.com', 'northwind.com')).toBe(false);
    expect(isAdminMailboxAddress('admin@evil.com', 'northwind.com')).toBe(false);
    expect(isAdminMailboxAddress('admin@eng.northwind.com', 'northwind.com')).toBe(false);
  });
});

describe('decideDomainVerification', () => {
  const claim = { orgId: 'org-a', verifiedAt: null };

  it('SEC-1 (partial) a proven claim on a domain nobody holds is verified', () => {
    expect(decideDomainVerification({ claim, verifiedByOrgId: null, proven: true })).toEqual({ action: 'verify' });
  });

  it('SEC-1 (partial) an unproven claim is refused and changes nothing', () => {
    expect(decideDomainVerification({ claim, verifiedByOrgId: null, proven: false })).toEqual({ action: 'refuse', reason: 'proof_not_found' });
  });

  it('SEC-1 (partial) a second org proving a domain another org already holds is refused, even with a valid proof', () => {
    expect(decideDomainVerification({ claim, verifiedByOrgId: 'org-b', proven: true })).toEqual({ action: 'refuse', reason: 'claimed_by_another_org' });
  });

  it('SEC-1 (partial) re-verifying a domain the org already holds is a no-op', () => {
    expect(decideDomainVerification({ claim: { orgId: 'org-a', verifiedAt: T0 }, verifiedByOrgId: 'org-a', proven: true })).toEqual({ action: 'already_verified' });
  });
});

describe('decideAutoJoin', () => {
  const eligible = {
    emailVerified: true,
    userCreatedAt: later(1000),
    domainVerifiedAt: T0,
    isMember: false,
    alreadyAutoJoined: false,
    hasOpenInvite: false,
    isOrgGuest: false,
    orgActive: true,
  };

  it('SEC-1 (partial) a new account with a verified address on a verified domain joins', () => {
    expect(decideAutoJoin(eligible)).toEqual({ action: 'join' });
  });

  it('SEC-1 (partial) an unverified domain never auto-joins', () => {
    expect(decideAutoJoin({ ...eligible, domainVerifiedAt: null })).toEqual({ action: 'skip', reason: 'domain_not_verified' });
  });

  it('SEC-1 (partial) an unverified email address never auto-joins: an address is proven before it is trusted', () => {
    expect(decideAutoJoin({ ...eligible, emailVerified: false })).toEqual({ action: 'skip', reason: 'email_not_verified' });
  });

  it('SEC-1 (partial) only signups after the domain was verified join; verifying a domain never sweeps in existing accounts', () => {
    expect(decideAutoJoin({ ...eligible, userCreatedAt: later(-1) })).toEqual({ action: 'skip', reason: 'account_predates_verification' });
    expect(decideAutoJoin({ ...eligible, userCreatedAt: T0 })).toEqual({ action: 'join' });
  });

  it('SEC-1 (partial) a guest of the org is never auto-joined as a member (D-OW-24)', () => {
    expect(decideAutoJoin({ ...eligible, isOrgGuest: true })).toEqual({ action: 'skip', reason: 'org_guest' });
  });

  it('SEC-1 (partial) someone the domain already joined once is never re-added after leaving or removal', () => {
    expect(decideAutoJoin({ ...eligible, alreadyAutoJoined: true })).toEqual({ action: 'skip', reason: 'already_auto_joined' });
  });

  it('SEC-1 (partial) a member is left alone, and an open invite keeps the role the inviter chose', () => {
    expect(decideAutoJoin({ ...eligible, isMember: true })).toEqual({ action: 'skip', reason: 'already_member' });
    expect(decideAutoJoin({ ...eligible, hasOpenInvite: true })).toEqual({ action: 'skip', reason: 'invited' });
  });

  it('SEC-1 (partial) a lapsed org admits nobody (SEAT-9)', () => {
    expect(decideAutoJoin({ ...eligible, orgActive: false })).toEqual({ action: 'refuse', reason: 'org_lapsed' });
  });
});
