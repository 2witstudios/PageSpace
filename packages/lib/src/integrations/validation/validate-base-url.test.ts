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
import { validateIntegrationTargetUrl, type HostnameResolver } from './validate-base-url';

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
      'http://127.0.0.1:8080/hook',
      'http://127.1/hook',
      'http://2130706433/hook',
      'http://0.0.0.0/hook',
      'http://10.0.0.5/hook',
      'http://172.16.0.1/hook',
      'http://192.168.1.1/hook',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/hook', // CGNAT / Tailscale
      'http://100.127.255.254/hook',
      'http://224.0.0.1/hook', // multicast
      'http://198.18.0.1/hook', // benchmarking
      'http://192.0.2.1/hook', // TEST-NET-1
      'http://255.255.255.255/hook',
      'http://240.0.0.1/hook',
      'http://[::1]/hook',
      'http://[::]/hook',
      'http://[::ffff:127.0.0.1]/hook',
      'http://[::ffff:100.64.0.1]/hook',
      'http://[64:ff9b::a00:1]/hook', // NAT64 embedding 10.0.0.1
      'http://[fdaa:0:1:a7b:0:1:2:3]/hook', // Fly 6PN (ULA)
      'http://[fc00::1]/hook',
      'http://[fe80::1]/hook',
      'http://[ff02::1]/hook', // multicast
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

  describe('blocked hostnames and schemes', () => {
    const blocked = [
      'http://localhost:3000/api',
      'http://app.localhost/api',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://db.internal/api',
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
