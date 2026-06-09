import { describe, it, expect } from 'vitest';
import {
  ALLOWED_APP_ORIGINS,
  isAllowedNavigation,
  isAllowedAppUrl,
  isTrustedSenderUrl,
  classifyNavigation,
} from '../navigation-guard';

describe('isAllowedNavigation', () => {
  const appOrigin = 'https://pagespace.ai';

  it('allows same-origin navigation regardless of path/query/hash', () => {
    expect(isAllowedNavigation('https://pagespace.ai/dashboard', appOrigin)).toBe(true);
    expect(isAllowedNavigation('https://pagespace.ai/drive/123?x=1#h', appOrigin)).toBe(true);
    expect(isAllowedNavigation('https://pagespace.ai', appOrigin)).toBe(true);
  });

  it('blocks a different origin', () => {
    expect(isAllowedNavigation('https://evil.com/phish', appOrigin)).toBe(false);
  });

  it('blocks lookalike suffix/subdomain hosts', () => {
    expect(isAllowedNavigation('https://pagespace.ai.evil.com/', appOrigin)).toBe(false);
    expect(isAllowedNavigation('https://evil.pagespace.ai/', appOrigin)).toBe(false);
  });

  it('blocks a protocol downgrade to http on a secure origin', () => {
    expect(isAllowedNavigation('http://pagespace.ai/dashboard', appOrigin)).toBe(false);
  });

  it('blocks a different port', () => {
    expect(isAllowedNavigation('https://pagespace.ai:8443/', appOrigin)).toBe(false);
  });

  it('blocks non-http(s) schemes even on the same host', () => {
    expect(isAllowedNavigation('file:///etc/passwd', appOrigin)).toBe(false);
    expect(isAllowedNavigation('javascript:alert(1)', appOrigin)).toBe(false);
    expect(isAllowedNavigation('pagespace://auth-exchange?code=x', appOrigin)).toBe(false);
  });

  it('blocks unparseable input and empty strings', () => {
    expect(isAllowedNavigation('not-a-url', appOrigin)).toBe(false);
    expect(isAllowedNavigation('', appOrigin)).toBe(false);
  });

  it('fails closed on an unparseable app origin', () => {
    expect(isAllowedNavigation('https://pagespace.ai/x', 'not-an-origin')).toBe(false);
  });

  it('supports localhost http app origins for development', () => {
    expect(isAllowedNavigation('http://localhost:3000/dashboard', 'http://localhost:3000')).toBe(true);
    expect(isAllowedNavigation('http://localhost:3001/dashboard', 'http://localhost:3000')).toBe(false);
  });
});

describe('isAllowedAppUrl', () => {
  it('accepts URLs whose origin is in the static allowlist', () => {
    expect(isAllowedAppUrl('https://pagespace.ai/dashboard', ALLOWED_APP_ORIGINS)).toBe(true);
    expect(isAllowedAppUrl('https://www.pagespace.ai', ALLOWED_APP_ORIGINS)).toBe(true);
    expect(isAllowedAppUrl('http://localhost:3000/x', ALLOWED_APP_ORIGINS)).toBe(true);
    expect(isAllowedAppUrl('http://127.0.0.1:3000', ALLOWED_APP_ORIGINS)).toBe(true);
  });

  it('rejects origins not in the allowlist', () => {
    expect(isAllowedAppUrl('https://evil.com', ALLOWED_APP_ORIGINS)).toBe(false);
    expect(isAllowedAppUrl('https://pagespace.ai.evil.com', ALLOWED_APP_ORIGINS)).toBe(false);
  });

  it('rejects a protocol downgrade on an https allowlist origin', () => {
    expect(isAllowedAppUrl('http://pagespace.ai', ALLOWED_APP_ORIGINS)).toBe(false);
  });

  it('rejects custom schemes and unparseable values', () => {
    expect(isAllowedAppUrl('pagespace://evil', ALLOWED_APP_ORIGINS)).toBe(false);
    expect(isAllowedAppUrl('file:///tmp', ALLOWED_APP_ORIGINS)).toBe(false);
    expect(isAllowedAppUrl('', ALLOWED_APP_ORIGINS)).toBe(false);
    expect(isAllowedAppUrl('javascript:alert(1)', ALLOWED_APP_ORIGINS)).toBe(false);
  });

  it('honors a caller-supplied allowlist (e.g. env-configured origin)', () => {
    const allowlist = [...ALLOWED_APP_ORIGINS, 'https://app.example.com'];
    expect(isAllowedAppUrl('https://app.example.com/dashboard', allowlist)).toBe(true);
    expect(isAllowedAppUrl('https://other.example.com', allowlist)).toBe(false);
  });

  it('ignores unparseable allowlist entries', () => {
    expect(isAllowedAppUrl('https://pagespace.ai', ['', 'garbage', 'https://pagespace.ai'])).toBe(true);
    expect(isAllowedAppUrl('https://pagespace.ai', ['', 'garbage'])).toBe(false);
  });
});

describe('classifyNavigation', () => {
  const appOrigin = 'https://pagespace.ai';

  it('allows same-origin navigation', () => {
    expect(classifyNavigation('https://pagespace.ai/dashboard', appOrigin)).toBe('allow');
  });

  it('passes the app deep-link scheme through to the OS handler', () => {
    expect(classifyNavigation('pagespace://auth-exchange?code=x&state=y', appOrigin)).toBe('deep-link');
    expect(classifyNavigation('pagespace://passkey-registered', appOrigin)).toBe('deep-link');
  });

  it('routes off-origin web links to the system browser', () => {
    expect(classifyNavigation('https://evil.com/phish', appOrigin)).toBe('open-external');
    expect(classifyNavigation('http://example.com/', appOrigin)).toBe('open-external');
  });

  it('blocks file:// and other custom schemes', () => {
    expect(classifyNavigation('file:///etc/passwd', appOrigin)).toBe('block');
    expect(classifyNavigation('javascript:alert(1)', appOrigin)).toBe('block');
    expect(classifyNavigation('mailto:a@b.c', appOrigin)).toBe('block');
  });

  it('blocks unparseable input', () => {
    expect(classifyNavigation('not a url', appOrigin)).toBe('block');
    expect(classifyNavigation('', appOrigin)).toBe('block');
  });

  it('does not allow a foreign origin even when the app origin is unparseable', () => {
    // Caller fails closed on a bad origin; this fn must never return "allow".
    expect(classifyNavigation('https://evil.com', 'garbage')).toBe('open-external');
    expect(classifyNavigation('https://pagespace.ai', 'garbage')).not.toBe('allow');
  });
});

describe('isTrustedSenderUrl', () => {
  const appOrigin = 'https://pagespace.ai';

  it('trusts a sender frame on the app origin', () => {
    expect(isTrustedSenderUrl('https://pagespace.ai/dashboard', appOrigin)).toBe(true);
  });

  it('fails closed when the sender URL is missing', () => {
    expect(isTrustedSenderUrl(undefined, appOrigin)).toBe(false);
    expect(isTrustedSenderUrl(null, appOrigin)).toBe(false);
    expect(isTrustedSenderUrl('', appOrigin)).toBe(false);
  });

  it('rejects a sender frame on a foreign or downgraded origin', () => {
    expect(isTrustedSenderUrl('https://evil.com', appOrigin)).toBe(false);
    expect(isTrustedSenderUrl('http://pagespace.ai', appOrigin)).toBe(false);
    expect(isTrustedSenderUrl('file:///offline.html', appOrigin)).toBe(false);
  });
});
