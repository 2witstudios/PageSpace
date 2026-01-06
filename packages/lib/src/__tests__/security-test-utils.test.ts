import { describe, it, expect } from 'vitest';
import {
  getMaliciousInputs,
  getAllMaliciousInputs,
  racingRequests,
  sequentialRace,
  extractJWTClaims,
  extractJWTHeader,
  tamperJWTClaim,
  measureExecutionTime,
  generateTestToken,
  hashToken,
  createMockHeaders,
  createMockRequest,
} from './security-test-utils';

describe('security-test-utils', () => {
  describe('getMaliciousInputs', () => {
    it('returns all categories of malicious inputs', () => {
      const inputs = getMaliciousInputs();

      expect(inputs.sqlInjection).toBeDefined();
      expect(inputs.xss).toBeDefined();
      expect(inputs.pathTraversal).toBeDefined();
      expect(inputs.ssrf).toBeDefined();
      expect(inputs.commandInjection).toBeDefined();
      expect(inputs.ldapInjection).toBeDefined();
      expect(inputs.headerInjection).toBeDefined();
      expect(inputs.nullByte).toBeDefined();
    });

    it('each category contains multiple test cases', () => {
      const inputs = getMaliciousInputs();

      for (const [_category, cases] of Object.entries(inputs)) {
        expect(cases.length).toBeGreaterThan(0);
        expect(Array.isArray(cases)).toBe(true);
      }
    });

    it('SQL injection inputs contain common patterns', () => {
      const inputs = getMaliciousInputs();

      expect(inputs.sqlInjection).toContainEqual(expect.stringContaining("'"));
      expect(inputs.sqlInjection).toContainEqual(expect.stringContaining('--'));
    });

    it('XSS inputs contain script tags', () => {
      const inputs = getMaliciousInputs();

      expect(inputs.xss).toContainEqual(expect.stringContaining('<script'));
    });

    it('path traversal inputs contain directory traversal', () => {
      const inputs = getMaliciousInputs();

      expect(inputs.pathTraversal).toContainEqual(expect.stringContaining('..'));
    });

    it('SSRF inputs contain internal URLs', () => {
      const inputs = getMaliciousInputs();

      expect(inputs.ssrf).toContainEqual(expect.stringContaining('localhost'));
      expect(inputs.ssrf).toContainEqual(expect.stringContaining('169.254'));
    });

    it('command injection inputs contain shell metacharacters', () => {
      const inputs = getMaliciousInputs();

      expect(inputs.commandInjection).toContainEqual(expect.stringContaining(';'));
      expect(inputs.commandInjection).toContainEqual(expect.stringContaining('|'));
    });

    it('LDAP injection inputs contain LDAP special characters', () => {
      const inputs = getMaliciousInputs();

      expect(inputs.ldapInjection).toContainEqual(expect.stringContaining('*'));
      expect(inputs.ldapInjection).toContainEqual(expect.stringContaining('('));
    });

    it('header injection inputs contain CRLF sequences', () => {
      const inputs = getMaliciousInputs();

      expect(inputs.headerInjection).toContainEqual(expect.stringContaining('\r\n'));
    });

    it('null byte inputs contain null characters', () => {
      const inputs = getMaliciousInputs();

      expect(inputs.nullByte).toContainEqual(expect.stringContaining('\x00'));
    });
  });

  describe('getAllMaliciousInputs', () => {
    it('returns flat array of all inputs', () => {
      const allInputs = getAllMaliciousInputs();
      const categorized = getMaliciousInputs();
      const expectedCount = Object.values(categorized).flat().length;

      expect(allInputs.length).toBe(expectedCount);
      expect(Array.isArray(allInputs)).toBe(true);
    });
  });

  describe('racingRequests', () => {
    it('executes multiple requests concurrently and demonstrates race conditions', async () => {
      let counter = 0;
      const increment = async () => {
        const current = counter;
        await new Promise((r) => setImmediate(r));
        counter = current + 1;
        return counter;
      };

      const results = await racingRequests(increment, 5);

      expect(results.length).toBe(5);
      // Due to race conditions, final counter should be less than 5
      // (multiple increments read the same value before any writes complete)
      expect(counter).toBeLessThan(5);
      // Results should contain duplicate values confirming race condition
      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBeLessThan(results.length);
    });

    it('uses default count of 10', async () => {
      const results = await racingRequests(async () => 'test');
      expect(results.length).toBe(10);
    });
  });

  describe('sequentialRace', () => {
    it('executes requests sequentially', async () => {
      const timestamps: number[] = [];
      const recordTime = async () => {
        timestamps.push(Date.now());
        return timestamps.length;
      };

      await sequentialRace(recordTime, 3, 10);

      expect(timestamps.length).toBe(3);
      // Each timestamp should be >= previous
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
      }
    });
  });

  describe('JWT utilities', () => {
    // Valid JWT for testing (header.payload.signature)
    const validJWT =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiJ1c2VyXzEyMyIsIm5hbWUiOiJUZXN0IFVzZXIiLCJpYXQiOjE1MTYyMzkwMjJ9.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

    describe('extractJWTClaims', () => {
      it('extracts claims from valid JWT', () => {
        const claims = extractJWTClaims(validJWT);

        expect(claims.sub).toBe('user_123');
        expect(claims.name).toBe('Test User');
        expect(claims.iat).toBe(1516239022);
      });

      it('throws for invalid JWT format', () => {
        expect(() => extractJWTClaims('invalid')).toThrow('Invalid JWT format');
        expect(() => extractJWTClaims('a.b')).toThrow('Invalid JWT format');
      });
    });

    describe('extractJWTHeader', () => {
      it('extracts header from valid JWT', () => {
        const header = extractJWTHeader(validJWT);

        expect(header.alg).toBe('HS256');
        expect(header.typ).toBe('JWT');
      });
    });

    describe('tamperJWTClaim', () => {
      it('modifies claim value', () => {
        const tampered = tamperJWTClaim(validJWT, 'sub', 'admin_999');
        const claims = extractJWTClaims(tampered);

        expect(claims.sub).toBe('admin_999');
      });

      it('preserves other claims', () => {
        const tampered = tamperJWTClaim(validJWT, 'sub', 'admin_999');
        const claims = extractJWTClaims(tampered);

        expect(claims.name).toBe('Test User');
        expect(claims.iat).toBe(1516239022);
      });

      it('keeps original signature (for testing rejection)', () => {
        const tampered = tamperJWTClaim(validJWT, 'sub', 'admin_999');
        const parts = tampered.split('.');

        expect(parts[2]).toBe(validJWT.split('.')[2]);
      });
    });
  });

  describe('measureExecutionTime', () => {
    it('returns bigint nanoseconds', async () => {
      const time = await measureExecutionTime(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(typeof time).toBe('bigint');
      expect(time).toBeGreaterThan(0n);
    });
  });

  describe('generateTestToken', () => {
    it('generates token with prefix', () => {
      const token = generateTestToken('mcp');

      expect(token.startsWith('mcp_')).toBe(true);
    });

    it('generates unique tokens', () => {
      const token1 = generateTestToken();
      const token2 = generateTestToken();

      expect(token1).not.toBe(token2);
    });

    it('uses default prefix', () => {
      const token = generateTestToken();

      expect(token.startsWith('test_')).toBe(true);
    });
  });

  describe('hashToken', () => {
    it('returns consistent hash', () => {
      const hash1 = hashToken('my-secret-token');
      const hash2 = hashToken('my-secret-token');

      expect(hash1).toBe(hash2);
    });

    it('returns different hash for different tokens', () => {
      const hash1 = hashToken('token-a');
      const hash2 = hashToken('token-b');

      expect(hash1).not.toBe(hash2);
    });

    it('returns hex string', () => {
      const hash = hashToken('test');

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('createMockHeaders', () => {
    it('creates headers with defaults', () => {
      const headers = createMockHeaders();

      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('user-agent')).toBe('TestAgent/1.0');
    });

    it('allows overrides', () => {
      const headers = createMockHeaders({
        'content-type': 'text/plain',
        'x-custom': 'value',
      });

      expect(headers.get('content-type')).toBe('text/plain');
      expect(headers.get('x-custom')).toBe('value');
    });
  });

  describe('createMockRequest', () => {
    it('creates request with defaults', () => {
      const request = createMockRequest({});

      expect(request.method).toBe('GET');
      expect(request.url).toBe('http://localhost:3000/');
    });

    it('allows custom options', () => {
      const request = createMockRequest({
        method: 'POST',
        url: 'http://example.com/api',
        body: { test: true },
      });

      expect(request.method).toBe('POST');
      expect(request.url).toBe('http://example.com/api');
    });
  });
});
