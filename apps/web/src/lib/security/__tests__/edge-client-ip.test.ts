import { describe, it, expect } from 'vitest';
import { getClientIP } from '../edge-client-ip';

describe('getClientIP (edge)', () => {
  it('prefers fly-client-ip over x-forwarded-for', () => {
    const request = new Request('http://localhost', {
      headers: { 'fly-client-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
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
});
