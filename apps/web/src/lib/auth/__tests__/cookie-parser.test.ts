import { describe, it, expect } from 'vitest';
import { getSessionFromCookies } from '../cookie-config';

describe('getSessionFromCookies (cookie parser)', () => {
  it('given cookie header "session=ps_sess_abc123", should return "ps_sess_abc123"', () => {
    expect(getSessionFromCookies('session=ps_sess_abc123')).toBe('ps_sess_abc123');
  });

  it('given cookie header with value containing "=" like "other=base64==; session=ps_sess_abc", should parse session correctly', () => {
    expect(getSessionFromCookies('other=base64==; session=ps_sess_abc')).toBe('ps_sess_abc');
  });

  it('given duplicate cookie names "session=first; session=second", should return first occurrence', () => {
    // RFC 6265: when duplicates exist, the first value wins in the cookie library
    expect(getSessionFromCookies('session=first; session=second')).toBe('first');
  });

  it('given null cookie header, should return null', () => {
    expect(getSessionFromCookies(null)).toBeNull();
  });

  it('given empty string cookie header, should return null', () => {
    expect(getSessionFromCookies('')).toBeNull();
  });
});
