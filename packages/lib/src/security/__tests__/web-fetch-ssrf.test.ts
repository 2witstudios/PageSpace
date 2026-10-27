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
      ['deprecated 6to4 relay anycast 192.88.99.0/24', '192.88.99.1'],
      ['6a44 relay (not globally reachable)', '192.88.99.2'],
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

  // Given an IPv6 address outside global unicast, or one that embeds or
  // translates to a private IPv4, in ANY textual form, isPublicIp should be
  // false: public IPv6 is allowlisted to the IANA global unicast allocations,
  // never denylisted by prefix.
  describe('isPublicIp — blocks IPv6 that embeds, translates or reserves', () => {
    it.each([
      ['IPv4-translated (SIIT) private, hextet', '::ffff:0:a00:1'],
      ['IPv4-translated (SIIT) private, dotted', '::ffff:0:10.0.0.1'],
      ['IPv4-translated (SIIT) public', '::ffff:0:5db8:d822'],
      ['IPv4-mapped private, fully expanded', '0:0:0:0:0:ffff:a00:1'],
      ['IPv4-mapped metadata, leading zeros', '0000:0000:0000:0000:0000:ffff:a9fe:a9fe'],
      ['IPv4-compatible (deprecated) private', '::10.0.0.1'],
      ['loopback, fully expanded', '0:0:0:0:0:0:0:1'],
      ['local-use NAT64 64:ff9b:1::/48', '64:ff9b:1::a00:1'],
      ['discard-only 100::/64', '100::1'],
      ['6to4 embedding a private IPv4', '2002:a00:1::1'],
      ['6to4 embedding the deprecated relay 192.88.99.1', '2002:c058:6301::1'],
      ['Teredo 2001::/32', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
      ['IETF protocol assignments 2001::/23', '2001:10::1'],
      ['documentation 2001:db8::/32', '2001:db8::1'],
      ['documentation 3fff::/20', '3fff::1'],
      ['SRv6 SIDs 5f00::/16', '5f00::1'],
      ['retired 6bone 3ffe::/16', '3ffe::1'],
      ['unallocated 2004::/16', '2004::1'],
      ['unallocated 2e00::/7', '2e00::1'],
      ['unallocated 3000::/4', '3000::1'],
      ['unallocated beside 2610::/23', '2612::1'],
      ['unallocated inside 2001::/16 (2001:1000::/23)', '2001:1000::1'],
      ['unallocated inside 2001::/16 (2001:4e00::/23)', '2001:4e00::1'],
      ['unallocated inside 2001::/16 (2001:c000::/18)', '2001:c000::1'],
      ['unique-local, uppercase', 'FD00::1'],
      ['malformed IPv6 (fail closed)', 'not:an:ip'],
      ['too many groups (fail closed)', '1:2:3:4:5:6:7:8:9'],
      ['two "::" (fail closed)', '2606::4700::1'],
    ])('blocks %s', (_label, ip) => {
      const actual = isPublicIp(ip);
      const expected = false;
      expect(actual).toEqual(expected);
    });

    it.each([
      ['6to4 embedding a public IPv4', '2002:5db8:d822::1'],
      ['IPv4-mapped public, fully expanded', '0:0:0:0:0:ffff:5db8:d822'],
      ['public IPv6 with a zone id', '2606:4700:4700::1111%eth0'],
      ['IANA 2001::/16 (Google DNS)', '2001:4860:4860::8888'],
      ['IANA 2003::/18', '2003:e8::1'],
      ['IANA 2400::/12', '2400:cb00::1'],
      ['IANA 2610::/23', '2610:a1:1018::1'],
      ['IANA 2620::/23', '2620:fe::fe'],
      ['IANA 2630::/12', '2630::1'],
      ['IANA 2800::/12', '2800:3f0:4001::1'],
      ['IANA 2a00::/12', '2a00:1450:4001::1'],
      ['IANA 2c00::/12', '2c0f:fb50:4002::1'],
      ['IANA 2410::/12 (APNIC)', '2410::1'],
      ['IANA 2a10::/12 (RIPE NCC)', '2a10:50c0::1'],
      ['IANA 2001:8000::/19 (APNIC)', '2001:8000::1'],
    ])('allows %s', (_label, ip) => {
      const actual = isPublicIp(ip);
      const expected = true;
      expect(actual).toEqual(expected);
    });
  });

  describe('isPublicIp — allows public IPs', () => {
    it.each([
      ['public IPv4', '93.184.216.34'],
      ['public IPv4 (8.8.8.8)', '8.8.8.8'],
      ['AS112 192.31.196.0/24 (globally reachable)', '192.31.196.1'],
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
