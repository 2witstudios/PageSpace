import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isBlockedIP, validateExternalURL, safeFetch } from '../url-validator';

// Mock DNS resolution
vi.mock('dns', () => ({
  promises: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

import { promises as dns } from 'dns';

describe('URL Validator - SSRF Prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isBlockedIP', () => {
    describe('IPv4 private ranges', () => {
      it('blocks loopback addresses (127.0.0.0/8)', () => {
        expect(isBlockedIP('127.0.0.1')).toBe(true);
        expect(isBlockedIP('127.255.255.255')).toBe(true);
      });

      it('blocks Class A private (10.0.0.0/8)', () => {
        expect(isBlockedIP('10.0.0.1')).toBe(true);
        expect(isBlockedIP('10.255.255.255')).toBe(true);
      });

      it('blocks Class B private (172.16.0.0/12)', () => {
        expect(isBlockedIP('172.16.0.1')).toBe(true);
        expect(isBlockedIP('172.31.255.255')).toBe(true);
        // Outside range should be allowed
        expect(isBlockedIP('172.15.255.255')).toBe(false);
        expect(isBlockedIP('172.32.0.0')).toBe(false);
      });

      it('blocks Class C private (192.168.0.0/16)', () => {
        expect(isBlockedIP('192.168.0.1')).toBe(true);
        expect(isBlockedIP('192.168.255.255')).toBe(true);
      });

      it('blocks link-local (169.254.0.0/16)', () => {
        expect(isBlockedIP('169.254.0.1')).toBe(true);
        expect(isBlockedIP('169.254.169.254')).toBe(true); // AWS metadata
      });

      it('blocks reserved ranges (240.0.0.0/4)', () => {
        expect(isBlockedIP('240.0.0.1')).toBe(true);
        expect(isBlockedIP('255.255.255.255')).toBe(true);
      });

      it('allows public IPs', () => {
        expect(isBlockedIP('8.8.8.8')).toBe(false);
        expect(isBlockedIP('1.1.1.1')).toBe(false);
        expect(isBlockedIP('93.184.216.34')).toBe(false);
      });
    });

    describe('Cloud metadata endpoints', () => {
      it('blocks AWS/GCP metadata IP', () => {
        expect(isBlockedIP('169.254.169.254')).toBe(true);
      });

      it('blocks Alibaba Cloud metadata IP', () => {
        expect(isBlockedIP('100.100.100.200')).toBe(true);
      });

      it('blocks Azure wireserver IP', () => {
        expect(isBlockedIP('168.63.129.16')).toBe(true);
      });
    });

    describe('IPv6 addresses', () => {
      it('blocks loopback (::1)', () => {
        expect(isBlockedIP('::1')).toBe(true);
      });

      it('blocks unspecified (::)', () => {
        expect(isBlockedIP('::')).toBe(true);
      });

      it('blocks link-local (fe80::/10) including full range', () => {
        expect(isBlockedIP('fe80::1')).toBe(true);
        expect(isBlockedIP('fe80:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
        // Full fe80::/10 range spans fe80:: through febf::
        expect(isBlockedIP('fe90::1')).toBe(true);
        expect(isBlockedIP('fea0::1')).toBe(true);
        expect(isBlockedIP('feb0::1')).toBe(true);
        expect(isBlockedIP('febf::1')).toBe(true);
      });

      it('blocks unique local (fc00::/7)', () => {
        expect(isBlockedIP('fc00::1')).toBe(true);
        expect(isBlockedIP('fd00::1')).toBe(true);
      });
    });

    describe('IPv4-mapped IPv6', () => {
      it('normalizes and blocks IPv4-mapped IPv6 addresses (dotted form)', () => {
        expect(isBlockedIP('::ffff:127.0.0.1')).toBe(true);
        expect(isBlockedIP('::ffff:10.0.0.1')).toBe(true);
        expect(isBlockedIP('::ffff:192.168.1.1')).toBe(true);
      });

      it('normalizes and blocks IPv4-mapped IPv6 addresses (hex form)', () => {
        // ::ffff:7f00:1 = 127.0.0.1
        expect(isBlockedIP('::ffff:7f00:1')).toBe(true);
        // ::ffff:a00:1 = 10.0.0.1
        expect(isBlockedIP('::ffff:a00:1')).toBe(true);
        // ::ffff:c0a8:101 = 192.168.1.1
        expect(isBlockedIP('::ffff:c0a8:101')).toBe(true);
        // ::ffff:a9fe:a9fe = 169.254.169.254 (AWS metadata)
        expect(isBlockedIP('::ffff:a9fe:a9fe')).toBe(true);
      });

      it('allows public IPs in IPv4-mapped format', () => {
        expect(isBlockedIP('::ffff:8.8.8.8')).toBe(false);
        // 8.8.8.8 in hex: 0808:0808
        expect(isBlockedIP('::ffff:808:808')).toBe(false);
      });
    });
  });

  describe('validateExternalURL', () => {
    describe('protocol validation', () => {
      it('allows http and https', async () => {
        (dns.resolve4 as ReturnType<typeof vi.fn>).mockResolvedValue(['93.184.216.34']);
        (dns.resolve6 as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const httpResult = await validateExternalURL('http://example.com');
        expect(httpResult.valid).toBe(true);

        const httpsResult = await validateExternalURL('https://example.com');
        expect(httpsResult.valid).toBe(true);
      });

      it('blocks file:// protocol', async () => {
        const result = await validateExternalURL('file:///etc/passwd');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Protocol not allowed');
      });

      it('blocks javascript: protocol', async () => {
        const result = await validateExternalURL('javascript:alert(1)');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Protocol not allowed');
      });

      it('blocks data: protocol', async () => {
        const result = await validateExternalURL('data:text/html,<script>alert(1)</script>');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Protocol not allowed');
      });
    });

    describe('hostname validation', () => {
      it('blocks localhost', async () => {
        const result = await validateExternalURL('http://localhost/api');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Hostname blocked');
      });

      it('blocks .local domains', async () => {
        const result = await validateExternalURL('http://myserver.local/api');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Hostname blocked');
      });

      it('blocks .internal domains', async () => {
        const result = await validateExternalURL('http://metadata.google.internal');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Hostname blocked');
      });

      it('blocks cloud metadata hostnames', async () => {
        const result = await validateExternalURL('http://metadata.azure.com/metadata');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Hostname blocked');
      });

      it('blocks hostnames with trailing dots (FQDN notation)', async () => {
        // DNS treats localhost. identically to localhost
        const result = await validateExternalURL('http://localhost./api');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Hostname blocked');
      });

      it('blocks .internal with trailing dot', async () => {
        const result = await validateExternalURL('http://metadata.google.internal.');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Hostname blocked');
      });
    });

    describe('IP address validation', () => {
      it('blocks direct private IP in URL', async () => {
        const result = await validateExternalURL('http://192.168.1.1/admin');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('IP address blocked');
      });

      it('blocks loopback IP in URL', async () => {
        const result = await validateExternalURL('http://127.0.0.1:8080/api');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('IP address blocked');
      });

      it('allows private IPs when explicitly enabled', async () => {
        const result = await validateExternalURL('http://192.168.1.1/admin', {
          allowPrivateIPs: true,
        });
        expect(result.valid).toBe(true);
      });
    });

    describe('SSRF bypass prevention - numeric/abbreviated IP forms', () => {
      // JavaScript's URL constructor normalizes these to dotted-quad format,
      // so they are caught by isBlockedIP after normalization

      it('blocks decimal IP form (2130706433 = 127.0.0.1)', async () => {
        const result = await validateExternalURL('http://2130706433/api');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('IP address blocked');
        expect(result.error).toContain('127.0.0.1'); // URL constructor normalizes this
      });

      it('blocks abbreviated IP form (127.1 = 127.0.0.1)', async () => {
        const result = await validateExternalURL('http://127.1/api');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('IP address blocked');
      });

      it('blocks two-octet abbreviated IP (10.1 = 10.0.0.1)', async () => {
        const result = await validateExternalURL('http://10.1/api');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('IP address blocked');
      });

      it('blocks three-octet abbreviated IP (192.168.1 = 192.168.0.1)', async () => {
        const result = await validateExternalURL('http://192.168.1/api');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('IP address blocked');
      });

      it('blocks hex IP form (0x7f000001 = 127.0.0.1)', async () => {
        const result = await validateExternalURL('http://0x7f000001/api');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('IP address blocked');
      });

      it('allows valid public dotted-quad IP', async () => {
        const result = await validateExternalURL('http://8.8.8.8/api');
        expect(result.valid).toBe(true);
      });

      it('allows valid hostname that looks numeric-ish but is valid domain', async () => {
        (dns.resolve4 as ReturnType<typeof vi.fn>).mockResolvedValue(['93.184.216.34']);
        (dns.resolve6 as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const result = await validateExternalURL('http://123abc.example.com/api');
        expect(result.valid).toBe(true);
      });
    });

    describe('DNS resolution validation', () => {
      it('resolves and validates all DNS results', async () => {
        (dns.resolve4 as ReturnType<typeof vi.fn>).mockResolvedValue(['93.184.216.34']);
        (dns.resolve6 as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const result = await validateExternalURL('https://example.com');
        expect(result.valid).toBe(true);
        expect(result.resolvedIPs).toContain('93.184.216.34');
      });

      it('blocks if any resolved IP is private', async () => {
        // Attacker could set up DNS to return both public and private IPs
        (dns.resolve4 as ReturnType<typeof vi.fn>).mockResolvedValue(['93.184.216.34', '127.0.0.1']);
        (dns.resolve6 as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const result = await validateExternalURL('https://malicious.example.com');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('resolves to blocked IP');
      });

      it('handles DNS resolution failures', async () => {
        (dns.resolve4 as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('NXDOMAIN'));
        (dns.resolve6 as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('NXDOMAIN'));

        const result = await validateExternalURL('https://nonexistent.example.com');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Could not resolve hostname');
      });

      it('can skip DNS check when requested', async () => {
        const result = await validateExternalURL('https://example.com', {
          skipDNSCheck: true,
        });
        expect(result.valid).toBe(true);
        expect(dns.resolve4).not.toHaveBeenCalled();
      });
    });

    describe('invalid URLs', () => {
      it('rejects invalid URL format', async () => {
        const result = await validateExternalURL('not-a-valid-url');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid URL format');
      });
    });
  });

  describe('safeFetch', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Use vi.stubGlobal for proper cleanup
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('throws on blocked URL', async () => {
      await expect(safeFetch('http://127.0.0.1/api')).rejects.toThrow(
        'SSRF protection'
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('validates redirects', async () => {
      (dns.resolve4 as ReturnType<typeof vi.fn>).mockResolvedValue(['93.184.216.34']);
      (dns.resolve6 as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      // First request returns redirect to localhost
      mockFetch.mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: 'http://127.0.0.1/internal' }),
      });

      await expect(safeFetch('https://example.com/redirect')).rejects.toThrow(
        'SSRF protection: Redirect to blocked URL'
      );
    });

    it('performs fetch on valid URL', async () => {
      (dns.resolve4 as ReturnType<typeof vi.fn>).mockResolvedValue(['93.184.216.34']);
      (dns.resolve6 as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const mockResponse = new Response('OK', { status: 200 });
      mockFetch.mockResolvedValue(mockResponse);

      const result = await safeFetch('https://example.com/api');
      expect(result.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api',
        expect.objectContaining({ redirect: 'manual' })
      );
    });

    it('throws on too many redirects', async () => {
      (dns.resolve4 as ReturnType<typeof vi.fn>).mockResolvedValue(['93.184.216.34']);
      (dns.resolve6 as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      // Create a chain of redirects that exceeds the limit
      mockFetch.mockImplementation(() => Promise.resolve({
        status: 302,
        headers: new Headers({ location: 'https://example.com/redirect' }),
      }));

      await expect(safeFetch('https://example.com/start', { maxRedirects: 3 })).rejects.toThrow(
        'SSRF protection: Too many redirects'
      );
    });

    it('follows valid redirects up to limit', async () => {
      (dns.resolve4 as ReturnType<typeof vi.fn>).mockResolvedValue(['93.184.216.34']);
      (dns.resolve6 as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      // First redirect
      mockFetch.mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: 'https://example.com/step2' }),
      });
      // Second redirect
      mockFetch.mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: 'https://example.com/final' }),
      });
      // Final response
      const mockResponse = new Response('OK', { status: 200 });
      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await safeFetch('https://example.com/start');
      expect(result.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});
