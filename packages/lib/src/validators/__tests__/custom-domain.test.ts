import { describe, it, expect } from 'vitest';
import {
  normalizeHostname,
  validateCustomDomain,
  buildDnsInstructions,
  isApexDomain,
  registrableDomain,
  verifyDnsRecords,
} from '../custom-domain';
import type { DnsInstructions, ResolvedRecords } from '../custom-domain';

describe('normalizeHostname', () => {
  it('lowercases the input', () => {
    expect(normalizeHostname('ACME.COM')).toBe('acme.com');
  });

  it('strips https:// scheme', () => {
    expect(normalizeHostname('https://acme.com')).toBe('acme.com');
  });

  it('strips http:// scheme', () => {
    expect(normalizeHostname('http://acme.com')).toBe('acme.com');
  });

  it('strips path component', () => {
    expect(normalizeHostname('https://acme.com/some/path')).toBe('acme.com');
  });

  it('strips port', () => {
    expect(normalizeHostname('acme.com:443')).toBe('acme.com');
  });

  it('strips trailing dot', () => {
    expect(normalizeHostname('acme.com.')).toBe('acme.com');
  });

  it('trims whitespace', () => {
    expect(normalizeHostname('  acme.com  ')).toBe('acme.com');
  });

  it('handles subdomain inputs', () => {
    expect(normalizeHostname('https://blog.acme.com/path?q=1')).toBe('blog.acme.com');
  });
});

describe('validateCustomDomain', () => {
  it('accepts a valid apex domain', () => {
    expect(validateCustomDomain('acme.com')).toEqual({ valid: true });
  });

  it('accepts a valid subdomain', () => {
    expect(validateCustomDomain('blog.acme.com')).toEqual({ valid: true });
  });

  it('accepts a valid deep subdomain', () => {
    expect(validateCustomDomain('docs.blog.acme.io')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    const result = validateCustomDomain('');
    expect(result.valid).toBe(false);
  });

  it('rejects a bare TLD with one label', () => {
    const result = validateCustomDomain('com');
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toMatch(/two labels/);
  });

  it('rejects labels with invalid chars', () => {
    const result = validateCustomDomain('ac_me.com');
    expect(result.valid).toBe(false);
  });

  it('rejects labels starting with hyphen', () => {
    const result = validateCustomDomain('-acme.com');
    expect(result.valid).toBe(false);
  });

  it('rejects labels ending with hyphen', () => {
    const result = validateCustomDomain('acme-.com');
    expect(result.valid).toBe(false);
  });

  it('rejects empty labels (double dot)', () => {
    const result = validateCustomDomain('acme..com');
    expect(result.valid).toBe(false);
  });

  it('rejects pagespace.ai as a custom domain', () => {
    const result = validateCustomDomain('pagespace.ai');
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toMatch(/pagespace/);
  });

  it('rejects subdomains of pagespace.ai', () => {
    const result = validateCustomDomain('sub.pagespace.ai');
    expect(result.valid).toBe(false);
  });

  it('rejects pagespace.site as a custom domain', () => {
    const result = validateCustomDomain('pagespace.site');
    expect(result.valid).toBe(false);
  });

  it('rejects subdomains of pagespace.site', () => {
    const result = validateCustomDomain('acme.pagespace.site');
    expect(result.valid).toBe(false);
  });

  it('rejects any *.pagespace.* host', () => {
    const result = validateCustomDomain('evil.pagespace.xyz');
    expect(result.valid).toBe(false);
  });

  it('still rejects pagespace.ai when allowPlatformDomain is false', () => {
    const result = validateCustomDomain('pagespace.ai', { allowPlatformDomain: false });
    expect(result.valid).toBe(false);
  });

  it('accepts pagespace.ai when allowPlatformDomain is true', () => {
    expect(validateCustomDomain('pagespace.ai', { allowPlatformDomain: true })).toEqual({ valid: true });
  });

  it('still rejects pagespace.site when allowPlatformDomain is true (not in PLATFORM_OWNED_DOMAINS)', () => {
    const result = validateCustomDomain('pagespace.site', { allowPlatformDomain: true });
    expect(result.valid).toBe(false);
  });

  it('still rejects an unrelated *.pagespace.* host even when allowPlatformDomain is true', () => {
    const result = validateCustomDomain('evil.pagespace.xyz', { allowPlatformDomain: true });
    expect(result.valid).toBe(false);
  });

  it('rejects hostnames exceeding 253 chars', () => {
    const long = 'a'.repeat(64) + '.' + 'b'.repeat(64) + '.' + 'c'.repeat(64) + '.' + 'd'.repeat(64);
    const result = validateCustomDomain(long);
    expect(result.valid).toBe(false);
  });

  it('rejects labels exceeding 63 chars', () => {
    const result = validateCustomDomain('a'.repeat(64) + '.com');
    expect(result.valid).toBe(false);
  });
});

describe('isApexDomain', () => {
  it('identifies apex domains (2 labels)', () => {
    expect(isApexDomain('acme.com')).toBe(true);
    expect(isApexDomain('example.io')).toBe(true);
  });

  it('identifies subdomains (3+ labels)', () => {
    expect(isApexDomain('www.acme.com')).toBe(false);
    expect(isApexDomain('blog.acme.com')).toBe(false);
    expect(isApexDomain('a.b.c.com')).toBe(false);
  });
});

describe('registrableDomain', () => {
  it('returns an apex domain unchanged', () => {
    expect(registrableDomain('jonowoodall.com')).toBe('jonowoodall.com');
    expect(registrableDomain('acme.io')).toBe('acme.io');
  });

  it('reduces a subdomain to its last two labels', () => {
    expect(registrableDomain('www.acme.com')).toBe('acme.com');
    expect(registrableDomain('blog.acme.com')).toBe('acme.com');
  });

  it('reduces a deep subdomain to its last two labels', () => {
    expect(registrableDomain('docs.blog.acme.io')).toBe('acme.io');
    expect(registrableDomain('a.b.c.d.example.com')).toBe('example.com');
  });

  it('strips a trailing dot', () => {
    expect(registrableDomain('www.acme.com.')).toBe('acme.com');
    expect(registrableDomain('acme.com.')).toBe('acme.com');
  });

  it('lowercases the result', () => {
    expect(registrableDomain('WWW.ACME.COM')).toBe('acme.com');
  });

  it('returns a single label unchanged', () => {
    expect(registrableDomain('localhost')).toBe('localhost');
  });

  it('returns empty string for empty input', () => {
    expect(registrableDomain('')).toBe('');
  });
});

describe('verifyDnsRecords', () => {
  const apexExpected: DnsInstructions = {
    isApex: true,
    records: [
      { type: 'A', name: '@', value: '1.2.3.4' },
      { type: 'AAAA', name: '@', value: '2001:db8::1' },
    ],
  };

  const subExpected: DnsInstructions = {
    isApex: false,
    records: [{ type: 'CNAME', name: 'www', value: 'proxy.pagespace.site' }],
  };

  const emptyResolved: ResolvedRecords = { a: [], aaaa: [], cname: [] };

  // Apex A record tests
  it('verifies apex when A record matches expected IPv4', () => {
    const result = verifyDnsRecords({
      hostname: 'acme.com',
      expected: apexExpected,
      resolved: { ...emptyResolved, a: ['1.2.3.4'] },
    });
    expect(result.verified).toBe(true);
  });

  it('verifies apex when A record is in a multi-record set', () => {
    const result = verifyDnsRecords({
      hostname: 'acme.com',
      expected: apexExpected,
      resolved: { ...emptyResolved, a: ['9.9.9.9', '1.2.3.4'] },
    });
    expect(result.verified).toBe(true);
  });

  it('fails apex when A record does not match expected IP', () => {
    const result = verifyDnsRecords({
      hostname: 'acme.com',
      expected: apexExpected,
      resolved: { ...emptyResolved, a: ['5.5.5.5'] },
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/1\.2\.3\.4/);
  });

  it('fails apex when no A records are resolved (NXDOMAIN / not yet set)', () => {
    const result = verifyDnsRecords({
      hostname: 'acme.com',
      expected: apexExpected,
      resolved: emptyResolved,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/No A records/);
  });

  // AAAA record tests
  it('verifies apex when AAAA record also resolves (A still required)', () => {
    // AAAA alone is not sufficient; A is the required check
    const resultWithOnlyAAAA = verifyDnsRecords({
      hostname: 'acme.com',
      expected: apexExpected,
      resolved: { ...emptyResolved, aaaa: ['2001:db8::1'] },
    });
    expect(resultWithOnlyAAAA.verified).toBe(false);
  });

  // CNAME tests
  it('verifies subdomain when CNAME matches expected target', () => {
    const result = verifyDnsRecords({
      hostname: 'www.acme.com',
      expected: subExpected,
      resolved: { ...emptyResolved, cname: ['proxy.pagespace.site'] },
    });
    expect(result.verified).toBe(true);
  });

  it('verifies subdomain with trailing-dot CNAME value', () => {
    const result = verifyDnsRecords({
      hostname: 'www.acme.com',
      expected: subExpected,
      resolved: { ...emptyResolved, cname: ['proxy.pagespace.site.'] },
    });
    expect(result.verified).toBe(true);
  });

  it('verifies subdomain with uppercase CNAME value (case-insensitive)', () => {
    const result = verifyDnsRecords({
      hostname: 'www.acme.com',
      expected: subExpected,
      resolved: { ...emptyResolved, cname: ['PROXY.PAGESPACE.SITE'] },
    });
    expect(result.verified).toBe(true);
  });

  it('fails subdomain when CNAME points elsewhere', () => {
    const result = verifyDnsRecords({
      hostname: 'www.acme.com',
      expected: subExpected,
      resolved: { ...emptyResolved, cname: ['other.example.com'] },
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/proxy\.pagespace\.site/);
  });

  it('fails subdomain when no CNAME is resolved (not yet set)', () => {
    const result = verifyDnsRecords({
      hostname: 'www.acme.com',
      expected: subExpected,
      resolved: emptyResolved,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/No CNAME/);
  });
});

describe('buildDnsInstructions', () => {
  const params = {
    edgeIpv4: '1.2.3.4',
    edgeIpv6: '2001:db8::1',
    cnameTarget: 'proxy.pagespace.site',
  };

  it('returns A + AAAA records for an apex domain', () => {
    const result = buildDnsInstructions({ hostname: 'acme.com', ...params });
    expect(result.isApex).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(result.records).toContainEqual({ type: 'A', name: '@', value: params.edgeIpv4 });
    expect(result.records).toContainEqual({ type: 'AAAA', name: '@', value: params.edgeIpv6 });
  });

  it('returns a CNAME record for a www subdomain', () => {
    const result = buildDnsInstructions({ hostname: 'www.acme.com', ...params });
    expect(result.isApex).toBe(false);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toEqual({ type: 'CNAME', name: 'www', value: params.cnameTarget });
  });

  it('returns a CNAME record for an arbitrary subdomain', () => {
    const result = buildDnsInstructions({ hostname: 'blog.acme.com', ...params });
    expect(result.isApex).toBe(false);
    expect(result.records[0]).toEqual({ type: 'CNAME', name: 'blog', value: params.cnameTarget });
  });

  it('preserves all subdomain labels for deep subdomains', () => {
    const result = buildDnsInstructions({ hostname: 'docs.blog.acme.com', ...params });
    expect(result.isApex).toBe(false);
    expect(result.records[0]).toEqual({ type: 'CNAME', name: 'docs.blog', value: params.cnameTarget });
  });
});
