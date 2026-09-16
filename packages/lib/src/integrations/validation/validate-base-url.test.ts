/**
 * Integration target URL validation tests.
 *
 * A connection's baseUrlOverride is user-supplied and becomes the fetch base for
 * every tool call, with the connection's credentials attached. It must never point
 * at any non-globally-routable address (loopback, private, CGNAT, link-local,
 * multicast, 6PN/ULA, mapped, cloud metadata, …) — as a literal or via DNS.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('dns', () => ({
  promises: {
    lookup: vi.fn(),
  },
}));

import { promises as dns } from 'dns';
import { validateIntegrationTargetUrl, HTTPS_REQUIRED_MESSAGE, type HostnameResolver } from './validate-base-url';

const PUBLIC = '93.184.216.34';
const publicResolver: HostnameResolver = async () => [PUBLIC];
const privateResolver: HostnameResolver = async () => ['10.1.2.3'];
const mixedResolver: HostnameResolver = async () => [PUBLIC, '127.0.0.1'];
const emptyResolver: HostnameResolver = async () => [];
const failingResolver: HostnameResolver = async () => {
  throw new Error('ENOTFOUND');
};
const neverResolver: HostnameResolver = () => new Promise(() => undefined);

const REJECTED = { ok: false, reason: expect.stringMatching(/blocked|not allowed|Invalid URL|public host/i) };

describe('validateIntegrationTargetUrl', () => {
  describe('IP literals (no DNS needed)', () => {
    const blockedLiterals = [
      'https://127.0.0.1:8080/hook',
      'https://127.1/hook',
      'https://2130706433/hook',
      'https://0.0.0.0/hook',
      'https://10.0.0.5/hook',
      'https://172.16.0.1/hook',
      'https://192.168.1.1/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.1/hook', // CGNAT / Tailscale
      'https://100.127.255.254/hook',
      'https://224.0.0.1/hook', // multicast
      'https://198.18.0.1/hook', // benchmarking
      'https://192.0.2.1/hook', // TEST-NET-1
      'https://255.255.255.255/hook',
      'https://240.0.0.1/hook',
      'https://[::1]/hook',
      'https://[::]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://[::ffff:100.64.0.1]/hook',
      'https://[64:ff9b::a00:1]/hook', // NAT64 embedding 10.0.0.1
      'https://[::ffff:0:a00:1]/hook', // IPv4-translated (SIIT) embedding 10.0.0.1
      'https://[2002:a00:1::1]/hook', // 6to4 embedding 10.0.0.1
      'https://[fdaa:0:1:a7b:0:1:2:3]/hook', // Fly 6PN (ULA)
      'https://[fc00::1]/hook',
      'https://[fe80::1]/hook',
      'https://[ff02::1]/hook', // multicast
    ];

    for (const url of blockedLiterals) {
      it(`given ${url}, should reject without resolving`, async () => {
        const resolve = vi.fn(publicResolver);
        const decision = await validateIntegrationTargetUrl(url, { resolve });
        expect(decision).toEqual(REJECTED);
        expect(resolve).not.toHaveBeenCalled();
      });
    }

    it('given a public IP literal, should accept it as the pinned address without resolving', async () => {
      const resolve = vi.fn(publicResolver);
      const decision = await validateIntegrationTargetUrl(`https://${PUBLIC}/api`, { resolve });
      expect(decision).toEqual({ ok: true, address: PUBLIC });
      expect(resolve).not.toHaveBeenCalled();
    });

    it('given a public IPv6 literal, should accept it as the pinned address', async () => {
      const decision = await validateIntegrationTargetUrl('https://[2606:2800:220:1:248:1893:25c8:1946]/api', { resolve: publicResolver });
      expect(decision).toEqual({ ok: true, address: '2606:2800:220:1:248:1893:25c8:1946' });
    });
  });

  describe('protocol', () => {
    it('given an http:// URL with a public IP literal, should reject naming HTTPS', async () => {
      const resolve = vi.fn(publicResolver);
      const decision = await validateIntegrationTargetUrl(`http://${PUBLIC}/api`, { resolve });
      expect(decision).toEqual({ ok: false, reason: expect.stringMatching(/HTTPS/i) });
      expect(resolve).not.toHaveBeenCalled();
    });

    it('given an http:// hostname that would resolve to a public address, should reject without resolving', async () => {
      const resolve = vi.fn(publicResolver);
      const decision = await validateIntegrationTargetUrl('http://hooks.example.com/x', { resolve });
      expect(decision).toEqual({ ok: false, reason: expect.stringMatching(/HTTPS/i) });
      expect(resolve).not.toHaveBeenCalled();
    });

    it('given an http:// URL, should say the refusal reason mentions cleartext credentials', async () => {
      const decision = await validateIntegrationTargetUrl('http://hooks.example.com/x', { resolve: publicResolver });
      expect(decision).toEqual({ ok: false, reason: HTTPS_REQUIRED_MESSAGE });
      expect(HTTPS_REQUIRED_MESSAGE).toMatch(/cleartext/i);
    });

    it('given an https:// URL with a public target, should accept (control)', async () => {
      const decision = await validateIntegrationTargetUrl('https://hooks.example.com/x', { resolve: publicResolver });
      expect(decision).toEqual({ ok: true, address: PUBLIC });
    });
  });

  describe('blocked hostnames and schemes', () => {
    const blocked = [
      'https://localhost:3000/api',
      'https://app.localhost/api',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://db.internal/api',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'gopher://example.com/x',
      'not a url',
    ];

    for (const url of blocked) {
      it(`given ${url}, should reject without resolving`, async () => {
        const resolve = vi.fn(publicResolver);
        const decision = await validateIntegrationTargetUrl(url, { resolve });
        expect(decision).toEqual(REJECTED);
        expect(resolve).not.toHaveBeenCalled();
      });
    }
  });

  describe('hostnames resolved through DNS', () => {
    it('given a hostname resolving to a private address, should reject', async () => {
      const decision = await validateIntegrationTargetUrl('https://hooks.corp.example/x', { resolve: privateResolver });
      expect(decision).toEqual(REJECTED);
    });

    it('given a hostname where ANY resolved address is private, should reject', async () => {
      const decision = await validateIntegrationTargetUrl('https://hooks.corp.example/x', { resolve: mixedResolver });
      expect(decision).toEqual(REJECTED);
    });

    it.each([
      ['CGNAT', '100.64.0.1'],
      ['multicast', '224.0.0.1'],
      ['ULA (6PN)', 'fdaa:0:1:a7b:0:1:2:3'],
      ['IPv6 link-local', 'fe80::1'],
      ['mapped loopback', '::ffff:127.0.0.1'],
      ['NAT64-embedded private', '64:ff9b::a00:1'],
      ['IPv4-translated (SIIT) private', '::ffff:0:a00:1'],
      ['Teredo', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
      ['not an IP at all', 'garbage'],
    ])('given a hostname resolving to %s (%s), should reject', async (_label, address) => {
      const decision = await validateIntegrationTargetUrl('https://hooks.corp.example/x', { resolve: async () => [address] });
      expect(decision).toEqual(REJECTED);
    });

    it('given a hostname resolving to no addresses, should reject (fail closed)', async () => {
      const decision = await validateIntegrationTargetUrl('https://hooks.corp.example/x', { resolve: emptyResolver });
      expect(decision.ok).toBe(false);
    });

    it('given a resolver failure, should reject (fail closed)', async () => {
      const decision = await validateIntegrationTargetUrl('https://hooks.corp.example/x', { resolve: failingResolver });
      expect(decision.ok).toBe(false);
    });

    it('given a hostname resolving only to public addresses, should accept and pin the first address', async () => {
      const decision = await validateIntegrationTargetUrl('https://api.github.com/', {
        resolve: async () => ['140.82.112.6', '140.82.113.6'],
      });
      expect(decision).toEqual({ ok: true, address: '140.82.112.6' });
    });

    it('given no resolver, should resolve through dns.lookup with every address', async () => {
      vi.mocked(dns.lookup).mockResolvedValue([
        { address: PUBLIC, family: 4 },
        { address: '192.168.0.9', family: 4 },
      ] as never);

      const decision = await validateIntegrationTargetUrl('https://api.github.com/');

      expect(dns.lookup).toHaveBeenCalledWith('api.github.com', { all: true });
      expect(decision).toEqual(REJECTED);
    });
  });

  describe('abort signal', () => {
    it('given a signal that aborts while the resolver is pending, should reject with an AbortError', async () => {
      const controller = new AbortController();
      const pending = validateIntegrationTargetUrl('https://slow.example/x', { resolve: neverResolver, signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('given an already-aborted signal, should reject with an AbortError without resolving', async () => {
      const controller = new AbortController();
      controller.abort();
      const resolve = vi.fn(publicResolver);
      await expect(
        validateIntegrationTargetUrl('https://slow.example/x', { resolve, signal: controller.signal })
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(resolve).not.toHaveBeenCalled();
    });

    it('given a signal that never aborts, should resolve normally', async () => {
      const controller = new AbortController();
      const decision = await validateIntegrationTargetUrl('https://api.github.com/', { resolve: publicResolver, signal: controller.signal });
      expect(decision).toEqual({ ok: true, address: PUBLIC });
    });
  });
});
