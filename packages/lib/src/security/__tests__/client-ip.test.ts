import { describe, it, expect } from 'vitest';
import { getClientIP } from '../client-ip';

describe('getClientIP', () => {
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
});
