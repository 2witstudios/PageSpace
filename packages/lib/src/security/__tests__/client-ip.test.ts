import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getClientIP } from '../client-ip';

describe('getClientIP', () => {
  // Fly-Client-IP is only trustworthy when the request genuinely traversed
  // Fly's own edge, which FLY_APP_NAME (Fly's own runtime-injected env var)
  // is used to detect. Most of this suite simulates "running on Fly" since
  // that's the deployed-cloud case; the dedicated describe block below covers
  // the non-Fly (tenant/self-hosted) case where the header must be ignored.
  const ORIGINAL_FLY_APP_NAME = process.env.FLY_APP_NAME;

  beforeEach(() => {
    process.env.FLY_APP_NAME = 'pagespace-web';
  });

  afterEach(() => {
    if (ORIGINAL_FLY_APP_NAME === undefined) {
      delete process.env.FLY_APP_NAME;
    } else {
      process.env.FLY_APP_NAME = ORIGINAL_FLY_APP_NAME;
    }
  });

  it('prefers fly-client-ip over x-forwarded-for', () => {
    const request = new Request('http://localhost', {
      headers: { 'fly-client-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    });
    expect(getClientIP(request)).toBe('9.9.9.9');
  });

  it('prefers fly-client-ip over x-real-ip', () => {
    const request = new Request('http://localhost', {
      headers: { 'fly-client-ip': '9.9.9.9', 'x-real-ip': '10.0.0.1' },
    });
    expect(getClientIP(request)).toBe('9.9.9.9');
  });

  it('trims whitespace from fly-client-ip', () => {
    const request = new Request('http://localhost', {
      headers: { 'fly-client-ip': '  9.9.9.9  ' },
    });
    expect(getClientIP(request)).toBe('9.9.9.9');
  });

  it('falls back to the first x-forwarded-for entry when fly-client-ip is absent', () => {
    const request = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    });
    expect(getClientIP(request)).toBe('1.2.3.4');
  });

  it('falls back to x-real-ip when fly-client-ip and x-forwarded-for are absent', () => {
    const request = new Request('http://localhost', {
      headers: { 'x-real-ip': '10.0.0.1' },
    });
    expect(getClientIP(request)).toBe('10.0.0.1');
  });

  it('returns unknown when no IP headers are present', () => {
    const request = new Request('http://localhost');
    expect(getClientIP(request)).toBe('unknown');
  });

  // Regression coverage: fly-client-ip is set fresh per Fly Proxy hop, not
  // chained. Traffic via pagespace.ai reaches this app through Caddy's
  // internal flycast relay — a second hop whose own edge overwrites
  // fly-client-ip with CADDY's own machine address (always in Fly's private
  // 6PN range, fdaa::/16), not the real visitor's. Preferring it unconditionally
  // (the pre-fix behavior) collapsed every pagespace.ai visitor into one
  // shared rate-limit bucket instead of trusting the visitor IP Caddy already
  // relayed as x-forwarded-for.
  describe('fly-client-ip in Fly 6PN range (arrived via the internal Caddy relay hop)', () => {
    it('prefers x-forwarded-for over a 6PN fly-client-ip', () => {
      const request = new Request('http://localhost', {
        headers: { 'fly-client-ip': 'fdaa:0:2ed2:a7b:19c:d9d2:5484:2', 'x-forwarded-for': '203.0.113.7' },
      });
      expect(getClientIP(request)).toBe('203.0.113.7');
    });

    it('is case-insensitive when detecting the 6PN prefix', () => {
      const request = new Request('http://localhost', {
        headers: { 'fly-client-ip': 'FDAA:0:2ed2:a7b:19c:d9d2:5484:2', 'x-forwarded-for': '203.0.113.7' },
      });
      expect(getClientIP(request)).toBe('203.0.113.7');
    });

    it('falls back to x-real-ip over a 6PN fly-client-ip when x-forwarded-for is absent', () => {
      const request = new Request('http://localhost', {
        headers: { 'fly-client-ip': 'fdaa:0:2ed2:a7b:19c:d9d2:5484:2', 'x-real-ip': '203.0.113.7' },
      });
      expect(getClientIP(request)).toBe('203.0.113.7');
    });

    it('falls back to the 6PN fly-client-ip itself as a last resort — still better than "unknown"', () => {
      const request = new Request('http://localhost', {
        headers: { 'fly-client-ip': 'fdaa:0:2ed2:a7b:19c:d9d2:5484:2' },
      });
      expect(getClientIP(request)).toBe('fdaa:0:2ed2:a7b:19c:d9d2:5484:2');
    });

    it('still prefers a non-6PN fly-client-ip over x-forwarded-for (direct-hit path, #1908)', () => {
      const request = new Request('http://localhost', {
        headers: { 'fly-client-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' },
      });
      expect(getClientIP(request)).toBe('9.9.9.9');
    });
  });

  // Regression coverage: this repo also ships a non-Fly `tenant` deployment
  // mode (infrastructure/docker-compose.tenant.yml, Traefik). On a host that
  // isn't actually Fly, fly-client-ip is just another ordinary,
  // client-settable header with zero trust guarantee — a caller could forge
  // it directly to bypass IP-keyed rate limits and poison audit/
  // device-fingerprint data, the exact class of attack #1908 exists to close.
  describe('not running on Fly (FLY_APP_NAME unset — e.g. tenant/self-hosted)', () => {
    beforeEach(() => {
      delete process.env.FLY_APP_NAME;
    });

    it('ignores a forged fly-client-ip entirely and falls back to x-forwarded-for', () => {
      const request = new Request('http://localhost', {
        headers: { 'fly-client-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' },
      });
      expect(getClientIP(request)).toBe('1.2.3.4');
    });

    it('ignores a forged fly-client-ip and falls back to x-real-ip when x-forwarded-for is absent', () => {
      const request = new Request('http://localhost', {
        headers: { 'fly-client-ip': '9.9.9.9', 'x-real-ip': '10.0.0.1' },
      });
      expect(getClientIP(request)).toBe('10.0.0.1');
    });

    it('returns unknown when only a forged fly-client-ip is present, never trusting it', () => {
      const request = new Request('http://localhost', {
        headers: { 'fly-client-ip': '9.9.9.9' },
      });
      expect(getClientIP(request)).toBe('unknown');
    });
  });
});
