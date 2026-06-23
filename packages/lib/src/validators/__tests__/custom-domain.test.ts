import { describe, it, expect } from 'vitest';
import {
  normalizeHostname,
  validateCustomDomain,
  buildDnsInstructions,
  isApexDomain,
} from '../custom-domain';

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
});
