import { describe, it, expect } from 'vitest';
import { readCookieValue, buildConsentCookieString } from '../cookie-utils';

describe('cookie-utils: readCookieValue', () => {
  it('reads a named cookie from a document.cookie string', () => {
    const raw = 'foo=1; ps_consent=%7B%22a%22%3A1%7D; bar=2';
    expect(readCookieValue(raw, 'ps_consent')).toBe('{"a":1}');
  });

  it('returns undefined when the cookie is absent', () => {
    expect(readCookieValue('foo=1; bar=2', 'ps_consent')).toBeUndefined();
  });

  it('returns undefined for an empty cookie string', () => {
    expect(readCookieValue('', 'ps_consent')).toBeUndefined();
  });

  it('does not match a cookie whose name is a prefix of another', () => {
    expect(readCookieValue('ps_consent_extra=zzz', 'ps_consent')).toBeUndefined();
  });
});

describe('cookie-utils: buildConsentCookieString', () => {
  it('URL-encodes the value and sets path, max-age, samesite', () => {
    const out = buildConsentCookieString('ps_consent', '{"a":1}', 1000);
    expect(out).toContain('ps_consent=%7B%22a%22%3A1%7D');
    expect(out).toContain('path=/');
    expect(out).toContain('max-age=1000');
    expect(out.toLowerCase()).toContain('samesite=lax');
  });
});
