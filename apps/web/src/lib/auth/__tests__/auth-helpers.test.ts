import { describe, it, expect } from 'vitest';
import {
  isSafeReturnUrl,
  isSafeNextPath,
  getClientIP,
  SIGNIN_NEXT_ALLOWED_PREFIXES,
} from '../auth-helpers';

/**
 * The exact shape `pagespace login` produces: the consent page sends its own
 * URL as `next`, and that URL's query embeds the CLI's percent-encoded
 * loopback redirect_uri. Rejecting this was the bug that dead-ended the
 * magic-link step-up flow for every passkey-less CLI user.
 */
const CLI_CONSENT_URL =
  '/oauth/consent?client_id=psc_cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A51739%2Fcallback' +
  '&response_type=code&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' +
  '&code_challenge_method=S256&scope=drive.read+drive.write&state=xyzABC123';

/**
 * Security-Critical: isSafeReturnUrl Open Redirect Prevention Tests
 *
 * OWASP A01:2021 - Broken Access Control
 * Open Redirect is a vulnerability where an attacker can redirect users
 * to malicious sites by manipulating URL parameters.
 *
 * This function implements zero-trust validation:
 * - Only relative paths are allowed (starting with /)
 * - Protocol-relative URLs (//evil.com) are blocked
 * - Backslash tricks (/\evil.com) are blocked
 * - Protocol schemes (javascript:, data:, etc.) are blocked
 * - URL-encoded bypass attempts are blocked
 *
 * Contract:
 * - Input: string | undefined
 * - Output: boolean (true = safe, false = unsafe)
 * - undefined/empty: returns true (defaults to /dashboard)
 * - Valid relative path: returns true
 * - Any external redirect attempt: returns false
 */

describe('isSafeReturnUrl', () => {
  describe('safe inputs (should return true)', () => {
    it('isSafeReturnUrl_undefined_returnsTrue', () => {
      expect(isSafeReturnUrl(undefined)).toBe(true);
    });

    it('isSafeReturnUrl_emptyString_returnsTrue', () => {
      expect(isSafeReturnUrl('')).toBe(true);
    });

    it('isSafeReturnUrl_rootPath_returnsTrue', () => {
      expect(isSafeReturnUrl('/')).toBe(true);
    });

    it('isSafeReturnUrl_simplePath_returnsTrue', () => {
      expect(isSafeReturnUrl('/dashboard')).toBe(true);
    });

    it('isSafeReturnUrl_nestedPath_returnsTrue', () => {
      expect(isSafeReturnUrl('/dashboard/settings/billing')).toBe(true);
    });

    it('isSafeReturnUrl_pathWithQueryString_returnsTrue', () => {
      expect(isSafeReturnUrl('/search?q=test&page=1')).toBe(true);
    });

    it('isSafeReturnUrl_pathWithHash_returnsTrue', () => {
      expect(isSafeReturnUrl('/docs#section-1')).toBe(true);
    });

    it('isSafeReturnUrl_pathWithQueryAndHash_returnsTrue', () => {
      expect(isSafeReturnUrl('/page?id=123#comments')).toBe(true);
    });

    it('isSafeReturnUrl_pathWithEncodedSpaces_returnsTrue', () => {
      expect(isSafeReturnUrl('/path%20with%20spaces')).toBe(true);
    });

    it('isSafeReturnUrl_pathWithNumbers_returnsTrue', () => {
      expect(isSafeReturnUrl('/user/12345/profile')).toBe(true);
    });

    it('isSafeReturnUrl_pathWithHyphensAndUnderscores_returnsTrue', () => {
      expect(isSafeReturnUrl('/my-page_name/sub-path')).toBe(true);
    });

    it('isSafeReturnUrl_cliConsentUrlWithEncodedLoopbackRedirectUri_returnsTrue', () => {
      expect(isSafeReturnUrl(CLI_CONSENT_URL)).toBe(true);
    });
  });

  describe('protocol-relative URL attacks (should return false)', () => {
    it('isSafeReturnUrl_protocolRelativeUrl_returnsFalse', () => {
      expect(isSafeReturnUrl('//evil.com')).toBe(false);
    });

    it('isSafeReturnUrl_protocolRelativeWithPath_returnsFalse', () => {
      expect(isSafeReturnUrl('//evil.com/phishing')).toBe(false);
    });

    it('isSafeReturnUrl_protocolRelativeWithPort_returnsFalse', () => {
      expect(isSafeReturnUrl('//evil.com:8080/steal-creds')).toBe(false);
    });

    it('isSafeReturnUrl_tripleSlash_returnsFalse', () => {
      expect(isSafeReturnUrl('///evil.com')).toBe(false);
    });
  });

  describe('backslash bypass attacks (should return false)', () => {
    it('isSafeReturnUrl_backslashAttack_returnsFalse', () => {
      expect(isSafeReturnUrl('/\\evil.com')).toBe(false);
    });

    it('isSafeReturnUrl_backslashWithPath_returnsFalse', () => {
      expect(isSafeReturnUrl('/\\evil.com/phishing')).toBe(false);
    });

    it('isSafeReturnUrl_doubleBackslash_returnsFalse', () => {
      // Some browsers interpret \\ as protocol-relative
      expect(isSafeReturnUrl('/\\\\evil.com')).toBe(false);
    });
  });

  describe('absolute URL attacks (should return false)', () => {
    it('isSafeReturnUrl_httpUrl_returnsFalse', () => {
      expect(isSafeReturnUrl('http://evil.com')).toBe(false);
    });

    it('isSafeReturnUrl_httpsUrl_returnsFalse', () => {
      expect(isSafeReturnUrl('https://evil.com')).toBe(false);
    });

    it('isSafeReturnUrl_ftpUrl_returnsFalse', () => {
      expect(isSafeReturnUrl('ftp://evil.com/file')).toBe(false);
    });
  });

  describe('JavaScript protocol attacks (XSS vectors - should return false)', () => {
    it('isSafeReturnUrl_javascriptProtocol_returnsFalse', () => {
      expect(isSafeReturnUrl('javascript:alert(1)')).toBe(false);
    });

    it('isSafeReturnUrl_javascriptWithNewlines_returnsFalse', () => {
      expect(isSafeReturnUrl('javascript:alert(document.cookie)')).toBe(false);
    });

    it('isSafeReturnUrl_mixedCaseJavascript_returnsFalse', () => {
      expect(isSafeReturnUrl('JAVASCRIPT:alert(1)')).toBe(false);
    });

    it('isSafeReturnUrl_jAvAsCrIpT_returnsFalse', () => {
      expect(isSafeReturnUrl('JaVaScRiPt:alert(1)')).toBe(false);
    });
  });

  describe('data URL attacks (should return false)', () => {
    it('isSafeReturnUrl_dataUrl_returnsFalse', () => {
      expect(isSafeReturnUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    });

    it('isSafeReturnUrl_dataUrlBase64_returnsFalse', () => {
      expect(isSafeReturnUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')).toBe(false);
    });

    it('isSafeReturnUrl_mixedCaseData_returnsFalse', () => {
      expect(isSafeReturnUrl('DATA:text/html,<script>alert(1)</script>')).toBe(false);
    });
  });

  describe('vbscript and other protocol attacks (should return false)', () => {
    it('isSafeReturnUrl_vbscriptProtocol_returnsFalse', () => {
      expect(isSafeReturnUrl('vbscript:msgbox(1)')).toBe(false);
    });

    it('isSafeReturnUrl_fileProtocol_returnsFalse', () => {
      expect(isSafeReturnUrl('file:///etc/passwd')).toBe(false);
    });

    it('isSafeReturnUrl_blobProtocol_returnsFalse', () => {
      expect(isSafeReturnUrl('blob:https://evil.com/uuid')).toBe(false);
    });
  });

  describe('URL-encoded bypass attacks (should return false)', () => {
    it('isSafeReturnUrl_encodedProtocolRelative_returnsFalse', () => {
      // %2f = /
      expect(isSafeReturnUrl('/%2fevil.com')).toBe(false);
    });

    it('isSafeReturnUrl_doubleEncodedProtocolRelative_returnsTrue', () => {
      // %252f = %2f when decoded once = /%2fevil.com (still a relative path, not //evil.com)
      // This is safe because we only decode once - double-decoding would be a separate vulnerability
      expect(isSafeReturnUrl('/%252fevil.com')).toBe(true);
    });

    it('isSafeReturnUrl_doubleEncodedDoubleSlash_returnsTrue', () => {
      // /%252F%252Fevil.com decodes ONCE to /%2F%2Fevil.com — still a relative
      // path, not //evil.com. Accepted by design: this validator decodes
      // exactly once, matching consumers, which navigate with the raw string
      // and never double-decode. A sink that double-decoded before navigating
      // would be its own vulnerability.
      expect(isSafeReturnUrl('/%252F%252Fevil.com')).toBe(true);
    });

    it('isSafeReturnUrl_encodedBackslash_returnsFalse', () => {
      // %5c = \
      expect(isSafeReturnUrl('/%5cevil.com')).toBe(false);
    });

    it('isSafeReturnUrl_encodedJavascript_returnsFalse', () => {
      // %6a%61%76%61%73%63%72%69%70%74 = javascript
      expect(isSafeReturnUrl('%6a%61%76%61%73%63%72%69%70%74:alert(1)')).toBe(false);
    });

    it('isSafeReturnUrl_encodedHttpInQueryValue_returnsTrue', () => {
      // Verdict deliberately flipped: an encoded absolute URL in a QUERY VALUE
      // is data, not a destination — navigation goes to /redirect on our own
      // origin (browsers never percent-decode before parsing scheme/host).
      // Rejecting this shape was the bug that broke the OAuth consent `next`
      // (its query carries redirect_uri=http%3A%2F%2F127.0.0.1...).
      expect(isSafeReturnUrl('/redirect?url=http%3A%2F%2Fevil.com')).toBe(true);
    });

    it('isSafeReturnUrl_nullByteInPath_returnsTrue', () => {
      // Null byte in middle of path - doesn't create open redirect
      // Path still starts with /safe, browser won't interpret as //evil.com
      expect(isSafeReturnUrl('/safe%00//evil.com')).toBe(true);
    });
  });

  describe('malformed URL attacks (should return false)', () => {
    it('isSafeReturnUrl_invalidUrlEncoding_returnsFalse', () => {
      // Invalid percent encoding should be rejected
      expect(isSafeReturnUrl('/path%GG')).toBe(false);
    });

    it('isSafeReturnUrl_incompletePercentEncoding_returnsFalse', () => {
      expect(isSafeReturnUrl('/path%2')).toBe(false);
    });

    it('isSafeReturnUrl_trailingPercent_returnsFalse', () => {
      expect(isSafeReturnUrl('/path%')).toBe(false);
    });
  });

  describe('edge cases without leading slash (should return false)', () => {
    it('isSafeReturnUrl_relativePath_returnsFalse', () => {
      expect(isSafeReturnUrl('dashboard')).toBe(false);
    });

    it('isSafeReturnUrl_dotSlash_returnsFalse', () => {
      expect(isSafeReturnUrl('./dashboard')).toBe(false);
    });

    it('isSafeReturnUrl_dotDotSlash_returnsFalse', () => {
      expect(isSafeReturnUrl('../dashboard')).toBe(false);
    });

    it('isSafeReturnUrl_plainDomain_returnsFalse', () => {
      expect(isSafeReturnUrl('evil.com')).toBe(false);
    });

    it('isSafeReturnUrl_domainWithPath_returnsFalse', () => {
      expect(isSafeReturnUrl('evil.com/phishing')).toBe(false);
    });
  });

  describe('whitespace and special character attacks (should return false)', () => {
    it('isSafeReturnUrl_leadingWhitespace_returnsFalse', () => {
      expect(isSafeReturnUrl(' /dashboard')).toBe(false);
    });

    it('isSafeReturnUrl_tabBeforePath_returnsFalse', () => {
      expect(isSafeReturnUrl('\t/dashboard')).toBe(false);
    });

    it('isSafeReturnUrl_newlineBeforePath_returnsFalse', () => {
      expect(isSafeReturnUrl('\n/dashboard')).toBe(false);
    });
  });

  describe('protocol embedded in the PATH portion (should return false)', () => {
    it('isSafeReturnUrl_javascriptInPathSegment_returnsFalse', () => {
      // The URL parser tolerates a colon inside a path segment, so the
      // path-scoped protocol scan must still catch it.
      expect(isSafeReturnUrl('/javascript:alert(1)')).toBe(false);
    });

    it('isSafeReturnUrl_encodedJavascriptInPathSegment_returnsFalse', () => {
      expect(isSafeReturnUrl('/%6a%61%76%61%73%63%72%69%70%74:alert(1)')).toBe(false);
    });
  });

  describe('protocol embedded in query VALUES (data, not a destination — should return true)', () => {
    // Verdicts deliberately flipped from the pre-fix behavior: these are
    // same-origin paths whose query merely CARRIES a URL as data. The
    // navigation target is /redirect (or /action) on our own origin. Scanning
    // query values for protocols was the bug that dead-ended the CLI login
    // magic-link flow.
    it('isSafeReturnUrl_httpInQueryParam_returnsTrue', () => {
      expect(isSafeReturnUrl('/redirect?to=http://evil.com')).toBe(true);
    });

    it('isSafeReturnUrl_javascriptInQueryParam_returnsTrue', () => {
      expect(isSafeReturnUrl('/action?callback=javascript:alert(1)')).toBe(true);
    });
  });

  describe('origin-parse guard (should return false)', () => {
    it('isSafeReturnUrl_httpsAbsoluteWithTrailingSlash_returnsFalse', () => {
      expect(isSafeReturnUrl('https://evil.com/')).toBe(false);
    });

    it('isSafeReturnUrl_protocolRelativeWithCredentials_returnsFalse', () => {
      expect(isSafeReturnUrl('//user@pagespace.invalid')).toBe(false);
    });
  });

  describe('ReDoS resistance (polynomial backtracking prevention)', () => {
    it('isSafeReturnUrl_longLetterSequence_completesInLinearTime', () => {
      // Crafted input that triggers O(N^2) backtracking in /[a-z]+:/i
      const malicious = '/' + 'a'.repeat(50_000);
      const start = performance.now();
      const result = isSafeReturnUrl(malicious);
      const elapsed = performance.now() - start;
      expect(result).toBe(true); // No protocol, so it's safe
      // Guards against O(N^2) blowup (which would take seconds at 50k chars),
      // not absolute speed — the bound must survive a fully loaded parallel
      // test run, where even linear work on 50k chars can take tens of ms.
      expect(elapsed).toBeLessThan(500);
    });

    it('isSafeReturnUrl_longLetterSequenceDecoded_completesInLinearTime', () => {
      // This input also passes through the decoded regex path
      const malicious = '/' + 'b'.repeat(50_000);
      const start = performance.now();
      isSafeReturnUrl(malicious);
      const elapsed = performance.now() - start;
      // Same rationale as above: catches quadratic blowup, tolerates load.
      expect(elapsed).toBeLessThan(500);
    });
  });
});

describe('isSafeNextPath', () => {
  const allowed = ['/dashboard', '/invite/', '/account'] as const;

  describe('safe inputs (allowlist match)', () => {
    it('given /dashboard exactly, should return true', () => {
      expect(isSafeNextPath({ path: '/dashboard', allowedPrefixes: allowed })).toBe(true);
    });

    it('given /dashboard/<driveId>?invited=1, should return true', () => {
      expect(
        isSafeNextPath({ path: '/dashboard/abc?invited=1', allowedPrefixes: allowed }),
      ).toBe(true);
    });

    it('given /dashboard with hash, should return true', () => {
      expect(isSafeNextPath({ path: '/dashboard#tab', allowedPrefixes: allowed })).toBe(true);
    });

    it('given /invite/abc/accept, should return true', () => {
      expect(isSafeNextPath({ path: '/invite/abc/accept', allowedPrefixes: allowed })).toBe(true);
    });

    it('given /account/settings, should return true', () => {
      expect(isSafeNextPath({ path: '/account/settings', allowedPrefixes: allowed })).toBe(true);
    });
  });

  describe('rejected: missing or empty input', () => {
    it('given undefined, should return false (no implicit fallback)', () => {
      expect(isSafeNextPath({ path: undefined, allowedPrefixes: allowed })).toBe(false);
    });

    it('given null, should return false', () => {
      expect(isSafeNextPath({ path: null, allowedPrefixes: allowed })).toBe(false);
    });

    it('given empty string, should return false', () => {
      expect(isSafeNextPath({ path: '', allowedPrefixes: allowed })).toBe(false);
    });
  });

  describe('rejected: not in allowlist', () => {
    it('given /, should return false', () => {
      expect(isSafeNextPath({ path: '/', allowedPrefixes: allowed })).toBe(false);
    });

    it('given /api/auth/logout, should return false', () => {
      expect(isSafeNextPath({ path: '/api/auth/logout', allowedPrefixes: allowed })).toBe(false);
    });

    it('given /auth/signin, should return false (not in allowlist)', () => {
      expect(isSafeNextPath({ path: '/auth/signin', allowedPrefixes: allowed })).toBe(false);
    });

    it('given /dashboardcake (segment-prefix bypass attempt), should return false', () => {
      expect(isSafeNextPath({ path: '/dashboardcake', allowedPrefixes: allowed })).toBe(false);
    });

    it('given /accountant (segment-prefix bypass), should return false', () => {
      expect(isSafeNextPath({ path: '/accountant', allowedPrefixes: allowed })).toBe(false);
    });
  });

  describe('rejected: open-redirect attack vectors (composed with isSafeReturnUrl)', () => {
    it('given //evil.com, should return false', () => {
      expect(isSafeNextPath({ path: '//evil.com', allowedPrefixes: allowed })).toBe(false);
    });

    it('given /\\evil.com (backslash trick), should return false', () => {
      expect(isSafeNextPath({ path: '/\\evil.com', allowedPrefixes: allowed })).toBe(false);
    });

    it('given https://evil.com, should return false', () => {
      expect(isSafeNextPath({ path: 'https://evil.com', allowedPrefixes: allowed })).toBe(false);
    });

    it('given javascript:alert(1), should return false', () => {
      expect(isSafeNextPath({ path: 'javascript:alert(1)', allowedPrefixes: allowed })).toBe(false);
    });

    it('given data:text/html,<script>, should return false', () => {
      expect(
        isSafeNextPath({ path: 'data:text/html,<script>', allowedPrefixes: allowed }),
      ).toBe(false);
    });

    it('given /%2fevil.com, should return false', () => {
      expect(isSafeNextPath({ path: '/%2fevil.com', allowedPrefixes: allowed })).toBe(false);
    });
  });

  describe('rejected: path traversal that escapes the allowlist after URL normalization', () => {
    it('given /dashboard/../etc, should return false (normalizes to /etc)', () => {
      expect(isSafeNextPath({ path: '/dashboard/../etc', allowedPrefixes: allowed })).toBe(false);
    });

    it('given /dashboard/../auth/login, should return false', () => {
      expect(
        isSafeNextPath({ path: '/dashboard/../auth/login', allowedPrefixes: allowed }),
      ).toBe(false);
    });
  });

  describe('rejected: empty allowlist', () => {
    it('given a valid path but empty allowlist, should return false', () => {
      expect(isSafeNextPath({ path: '/dashboard', allowedPrefixes: [] })).toBe(false);
    });
  });

  describe('CLI login consent URL under the real signin allowlist (THE regression)', () => {
    it('accepts the consent URL whose query embeds the encoded loopback redirect_uri', () => {
      expect(
        isSafeNextPath({ path: CLI_CONSENT_URL, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES }),
      ).toBe(true);
    });

    it('still rejects hostile shapes under the real signin allowlist', () => {
      for (const hostile of [
        '//evil.com',
        '/\\evil.com',
        'javascript:alert(1)',
        '/javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'https://evil.com/',
        '//user@pagespace.invalid',
        '/dashboard/../etc',
        '/path%GG',
      ]) {
        expect(
          isSafeNextPath({ path: hostile, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES }),
        ).toBe(false);
      }
    });
  });

  describe('"/" prefix means root only (regression: would otherwise match every path)', () => {
    const rootOnly = ['/'] as const;

    it('given path "/" with allowlist ["/"] , should return true', () => {
      expect(isSafeNextPath({ path: '/', allowedPrefixes: rootOnly })).toBe(true);
    });

    it('given path "/dashboard" with allowlist ["/"] , should return false (prefix means root, not everything)', () => {
      expect(isSafeNextPath({ path: '/dashboard', allowedPrefixes: rootOnly })).toBe(false);
    });

    it('given path "/api/auth/logout" with allowlist ["/"] , should return false', () => {
      expect(isSafeNextPath({ path: '/api/auth/logout', allowedPrefixes: rootOnly })).toBe(false);
    });
  });
});

describe('getClientIP', () => {
  describe('x-forwarded-for header handling', () => {
    it('getClientIP_singleIP_returnsIP', () => {
      const request = new Request('https://example.com', {
        headers: { 'x-forwarded-for': '192.168.1.1' },
      });
      expect(getClientIP(request)).toBe('192.168.1.1');
    });

    it('getClientIP_multipleIPs_returnsFirstIP', () => {
      const request = new Request('https://example.com', {
        headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.1, 172.16.0.1' },
      });
      expect(getClientIP(request)).toBe('192.168.1.1');
    });

    it('getClientIP_ipWithWhitespace_trimmed', () => {
      const request = new Request('https://example.com', {
        headers: { 'x-forwarded-for': '  192.168.1.1  ' },
      });
      expect(getClientIP(request)).toBe('192.168.1.1');
    });
  });

  describe('x-real-ip header handling', () => {
    it('getClientIP_xRealIP_returnsIP', () => {
      const request = new Request('https://example.com', {
        headers: { 'x-real-ip': '10.0.0.1' },
      });
      expect(getClientIP(request)).toBe('10.0.0.1');
    });

    it('getClientIP_bothHeaders_prefersXForwardedFor', () => {
      const request = new Request('https://example.com', {
        headers: {
          'x-forwarded-for': '192.168.1.1',
          'x-real-ip': '10.0.0.1',
        },
      });
      expect(getClientIP(request)).toBe('192.168.1.1');
    });
  });

  describe('fallback handling', () => {
    it('getClientIP_noHeaders_returnsUnknown', () => {
      const request = new Request('https://example.com');
      expect(getClientIP(request)).toBe('unknown');
    });

    it('getClientIP_emptyXForwardedFor_fallsBackToXRealIP', () => {
      const request = new Request('https://example.com', {
        headers: {
          'x-forwarded-for': '',
          'x-real-ip': '10.0.0.1',
        },
      });
      expect(getClientIP(request)).toBe('10.0.0.1');
    });
  });

  describe('IPv6 handling', () => {
    it('getClientIP_ipv6Address_returnsIPv6', () => {
      const request = new Request('https://example.com', {
        headers: { 'x-forwarded-for': '2001:db8::1' },
      });
      expect(getClientIP(request)).toBe('2001:db8::1');
    });

    it('getClientIP_ipv6WithZone_returnsIPv6', () => {
      const request = new Request('https://example.com', {
        headers: { 'x-forwarded-for': 'fe80::1%eth0' },
      });
      expect(getClientIP(request)).toBe('fe80::1%eth0');
    });
  });
});
