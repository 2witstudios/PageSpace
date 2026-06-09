import { describe, it, expect } from 'vitest';
import {
  isPublicIp,
  isAllowedFetchTarget,
  isIpLiteral,
  parseIpv4,
  PRIVATE_HOST_MESSAGE,
} from '../web-fetch-ssrf';

describe('web-fetch-ssrf — pure decision functions', () => {
  describe('parseIpv4', () => {
    it.each([
      ['dotted decimal', '127.0.0.1', 0x7f000001],
      ['decimal integer (127.0.0.1)', '2130706433', 0x7f000001],
      ['hex integer', '0x7f000001', 0x7f000001],
      ['octal dotted', '0177.0.0.1', 0x7f000001],
      ['hex dotted', '0x7f.0.0.1', 0x7f000001],
      ['short form 127.1', '127.1', 0x7f000001],
      ['metadata IP', '169.254.169.254', 0xa9fea9fe],
      ['broadcast', '255.255.255.255', 0xffffffff],
    ])('parses %s', (_label, input, expected) => {
      expect(parseIpv4(input)).toBe(expected >>> 0);
    });

    it.each([
      ['hostname', 'example.com'],
      ['too many parts', '1.2.3.4.5'],
      ['byte overflow', '256.1.1.1'],
      ['empty part', '1..2.3'],
      ['ipv6', '::1'],
      ['out of range integer', '4294967296'],
    ])('rejects %s', (_label, input) => {
      expect(parseIpv4(input)).toBeNull();
    });
  });

  describe('isPublicIp — blocks private / reserved IPv4', () => {
    it.each([
      ['loopback', '127.0.0.1'],
      ['loopback range', '127.10.20.30'],
      ['0.0.0.0', '0.0.0.0'],
      ['this-network range', '0.1.2.3'],
      ['RFC1918 /8', '10.0.0.1'],
      ['RFC1918 /12 low', '172.16.0.1'],
      ['RFC1918 /12 high', '172.31.255.255'],
      ['RFC1918 /16', '192.168.1.1'],
      ['link-local / metadata', '169.254.169.254'],
      ['carrier-grade NAT', '100.64.0.1'],
      ['IETF protocol', '192.0.0.1'],
      ['TEST-NET-1', '192.0.2.5'],
      ['benchmarking', '198.18.0.1'],
      ['TEST-NET-2', '198.51.100.7'],
      ['TEST-NET-3', '203.0.113.7'],
      ['multicast', '224.0.0.1'],
      ['reserved', '240.0.0.1'],
      ['broadcast', '255.255.255.255'],
      ['decimal-encoded loopback', '2130706433'],
      ['hex-encoded loopback', '0x7f000001'],
      ['octal-encoded loopback', '0177.0.0.1'],
      ['decimal-encoded metadata', '2852039166'],
    ])('blocks %s', (_label, ip) => {
      expect(isPublicIp(ip)).toBe(false);
    });
  });

  describe('isPublicIp — blocks private / reserved IPv6', () => {
    it.each([
      ['loopback', '::1'],
      ['unspecified', '::'],
      ['unique-local fc00::/7', 'fc00::1'],
      ['unique-local fd', 'fd12:3456::1'],
      ['link-local fe80::/10', 'fe80::1'],
      ['site-local fec0::/10', 'fec0::1'],
      ['multicast ff00::/8', 'ff02::1'],
      ['IPv4-mapped metadata (dotted)', '::ffff:169.254.169.254'],
      ['IPv4-mapped metadata (hextet)', '::ffff:a9fe:a9fe'],
      ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
      ['bracketed loopback', '[::1]'],
      ['NAT64', '64:ff9b::a9fe:a9fe'],
    ])('blocks %s', (_label, ip) => {
      expect(isPublicIp(ip)).toBe(false);
    });
  });

  describe('isPublicIp — allows public IPs', () => {
    it.each([
      ['public IPv4', '93.184.216.34'],
      ['public IPv4 (8.8.8.8)', '8.8.8.8'],
      ['public IPv6', '2606:4700:4700::1111'],
      ['IPv4-mapped public', '::ffff:93.184.216.34'],
    ])('allows %s', (_label, ip) => {
      expect(isPublicIp(ip)).toBe(true);
    });

    it('returns false for non-IP strings (fail-closed)', () => {
      expect(isPublicIp('example.com')).toBe(false);
      expect(isPublicIp('')).toBe(false);
      expect(isPublicIp('not-an-ip')).toBe(false);
    });
  });

  describe('isIpLiteral', () => {
    it.each([
      ['dotted v4', '127.0.0.1', true],
      ['decimal v4', '2130706433', true],
      ['ipv6', '::1', true],
      ['bracketed ipv6', '[2606:4700::1]', true],
      ['hostname', 'example.com', false],
      ['empty', '', false],
    ])('%s', (_label, host, expected) => {
      expect(isIpLiteral(host)).toBe(expected);
    });
  });

  describe('isAllowedFetchTarget', () => {
    it('allows a normal public https hostname (DNS validated downstream)', () => {
      expect(isAllowedFetchTarget('https://example.com/path')).toEqual({ ok: true });
    });

    it('allows a public https IP literal', () => {
      expect(isAllowedFetchTarget('https://93.184.216.34/')).toEqual({ ok: true });
    });

    it.each([
      ['http scheme', 'http://example.com'],
      ['ftp scheme', 'ftp://example.com'],
      ['file scheme', 'file:///etc/passwd'],
      ['gopher scheme', 'gopher://example.com'],
    ])('rejects non-https %s', (_label, url) => {
      const decision = isAllowedFetchTarget(url);
      expect(decision.ok).toBe(false);
      expect(decision.reason).toMatch(/https/i);
    });

    it.each([
      ['loopback literal', 'https://127.0.0.1/'],
      ['metadata literal', 'https://169.254.169.254/latest/meta-data'],
      ['decimal-encoded loopback', 'https://2130706433/'],
      ['hex-encoded loopback', 'https://0x7f000001/'],
      ['RFC1918 literal', 'https://10.0.0.1/'],
      ['bracketed ipv6 loopback', 'https://[::1]/'],
      ['ipv4-mapped metadata', 'https://[::ffff:a9fe:a9fe]/'],
      ['localhost', 'https://localhost/'],
      ['*.localhost', 'https://api.localhost/'],
    ])('rejects private/internal %s', (_label, url) => {
      const decision = isAllowedFetchTarget(url);
      expect(decision.ok).toBe(false);
      expect(decision.reason).toBe(PRIVATE_HOST_MESSAGE);
    });

    it('rejects an unparseable URL', () => {
      const decision = isAllowedFetchTarget('not a url');
      expect(decision.ok).toBe(false);
      expect(decision.reason).toMatch(/invalid url/i);
    });
  });
});
