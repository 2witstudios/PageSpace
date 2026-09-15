/**
 * Integration target URL validation tests.
 *
 * A connection's baseUrlOverride is user-supplied and becomes the fetch base for
 * every tool call, with the connection's credentials attached. It must never point
 * at loopback, private, link-local, 6PN or cloud-metadata addresses.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('dns', () => ({
  promises: {
    lookup: vi.fn(),
  },
}));

import { promises as dns } from 'dns';
import { validateIntegrationTargetUrl, type HostnameResolver } from './validate-base-url';

const publicResolver: HostnameResolver = async () => ['93.184.216.34'];
const privateResolver: HostnameResolver = async () => ['10.1.2.3'];
const mixedResolver: HostnameResolver = async () => ['93.184.216.34', '127.0.0.1'];
const emptyResolver: HostnameResolver = async () => [];
const failingResolver: HostnameResolver = async () => {
  throw new Error('ENOTFOUND');
};

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
      'http://[::1]/hook',
      'http://[::ffff:127.0.0.1]/hook',
      'http://[fdaa:0:1:a7b:0:1:2:3]/hook',
      'http://[fe80::1]/hook',
    ];

    for (const url of blockedLiterals) {
      it(`given ${url}, should reject without resolving`, async () => {
        const resolve = vi.fn(publicResolver);
        const decision = await validateIntegrationTargetUrl(url, resolve);
        expect(decision).toEqual({ ok: false, reason: expect.stringMatching(/blocked|not allowed|Invalid URL/i) });
        expect(resolve).not.toHaveBeenCalled();
      });
    }

    it('given a public IP literal, should accept without resolving', async () => {
      const resolve = vi.fn(publicResolver);
      const decision = await validateIntegrationTargetUrl('https://93.184.216.34/api', resolve);
      expect(decision).toEqual({ ok: true });
      expect(resolve).not.toHaveBeenCalled();
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
        const decision = await validateIntegrationTargetUrl(url, resolve);
        expect(decision).toEqual({ ok: false, reason: expect.stringMatching(/blocked|not allowed|Invalid URL/i) });
        expect(resolve).not.toHaveBeenCalled();
      });
    }
  });

  describe('hostnames resolved through DNS', () => {
    it('given a hostname resolving to a private address, should reject', async () => {
      const decision = await validateIntegrationTargetUrl('https://hooks.corp.example/x', privateResolver);
      expect(decision.ok).toBe(false);
    });

    it('given a hostname where ANY resolved address is private, should reject', async () => {
      const decision = await validateIntegrationTargetUrl('https://hooks.corp.example/x', mixedResolver);
      expect(decision.ok).toBe(false);
    });

    it('given a hostname resolving to no addresses, should reject (fail closed)', async () => {
      const decision = await validateIntegrationTargetUrl('https://hooks.corp.example/x', emptyResolver);
      expect(decision.ok).toBe(false);
    });

    it('given a resolver failure, should reject (fail closed)', async () => {
      const decision = await validateIntegrationTargetUrl('https://hooks.corp.example/x', failingResolver);
      expect(decision.ok).toBe(false);
    });

    it('given a hostname resolving only to public addresses, should accept', async () => {
      const decision = await validateIntegrationTargetUrl('https://api.github.com/', publicResolver);
      expect(decision).toEqual({ ok: true });
    });

    it('given no resolver, should resolve through dns.lookup with every address', async () => {
      vi.mocked(dns.lookup).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.0.9', family: 4 },
      ] as never);

      const decision = await validateIntegrationTargetUrl('https://api.github.com/');

      expect(dns.lookup).toHaveBeenCalledWith('api.github.com', { all: true });
      expect(decision.ok).toBe(false);
    });
  });
});
