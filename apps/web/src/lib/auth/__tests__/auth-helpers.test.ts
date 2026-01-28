import { describe, it, expect, vi } from 'vitest';
import { isSafeReturnUrl, getClientIP } from '../auth-helpers';

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

    it('isSafeReturnUrl_encodedBackslash_returnsFalse', () => {
      // %5c = \
      expect(isSafeReturnUrl('/%5cevil.com')).toBe(false);
    });

    it('isSafeReturnUrl_encodedJavascript_returnsFalse', () => {
      // %6a%61%76%61%73%63%72%69%70%74 = javascript
      expect(isSafeReturnUrl('%6a%61%76%61%73%63%72%69%70%74:alert(1)')).toBe(false);
    });

    it('isSafeReturnUrl_encodedHttpInPath_returnsFalse', () => {
      // Encoded http:// in what looks like a path
      expect(isSafeReturnUrl('/redirect?url=http%3A%2F%2Fevil.com')).toBe(false);
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

  describe('protocol embedded in path (should return false)', () => {
    it('isSafeReturnUrl_httpInQueryParam_returnsFalse', () => {
      expect(isSafeReturnUrl('/redirect?to=http://evil.com')).toBe(false);
    });

    it('isSafeReturnUrl_javascriptInQueryParam_returnsFalse', () => {
      expect(isSafeReturnUrl('/action?callback=javascript:alert(1)')).toBe(false);
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
