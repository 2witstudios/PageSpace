import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isLocalhostRequest,
  isInternalRequest,
  computeCronSignature,
  checkAndRecordNonce,
  validateSignedCronRequest,
  _resetNonceStore,
} from '../cron-auth';

describe('cron-auth', () => {
  describe('isInternalRequest', () => {
    it('should return true for localhost host header', () => {
      const request = new Request('http://localhost:3000/api/cron/test', {
        headers: { host: 'localhost:3000' },
      });

      expect(isInternalRequest(request)).toBe(true);
    });

    it('should return true for 127.0.0.1 host header', () => {
      const request = new Request('http://127.0.0.1:3000/api/cron/test', {
        headers: { host: '127.0.0.1:3000' },
      });

      expect(isInternalRequest(request)).toBe(true);
    });

    it('should return true for IPv6 localhost [::1]', () => {
      const request = new Request('http://[::1]:3000/api/cron/test', {
        headers: { host: '[::1]:3000' },
      });

      expect(isInternalRequest(request)).toBe(true);
    });

    it('should return true for docker internal hostname web:3000', () => {
      const request = new Request('http://web:3000/api/cron/test', {
        headers: { host: 'web:3000' },
      });

      expect(isInternalRequest(request)).toBe(true);
    });

    it('should return true for docker internal hostname web (no port)', () => {
      const request = new Request('http://web/api/cron/test', {
        headers: { host: 'web' },
      });

      expect(isInternalRequest(request)).toBe(true);
    });

    it('should return false for external host', () => {
      const request = new Request('https://pagespace.ai/api/cron/test', {
        headers: { host: 'pagespace.ai' },
      });

      expect(isInternalRequest(request)).toBe(false);
    });

    it('should return false when x-forwarded-for header is present', () => {
      const request = new Request('http://localhost:3000/api/cron/test', {
        headers: {
          host: 'localhost:3000',
          'x-forwarded-for': '203.0.113.195',
        },
      });

      expect(isInternalRequest(request)).toBe(false);
    });

    it('should return false when x-forwarded-for present even with docker host', () => {
      const request = new Request('http://web:3000/api/cron/test', {
        headers: {
          host: 'web:3000',
          'x-forwarded-for': '203.0.113.195',
        },
      });

      expect(isInternalRequest(request)).toBe(false);
    });

    it('should return false for missing host header', () => {
      const request = new Request('http://localhost:3000/api/cron/test');

      expect(isInternalRequest(request)).toBe(false);
    });
  });

  describe('isLocalhostRequest (alias)', () => {
    it('should be an alias for isInternalRequest', () => {
      expect(isLocalhostRequest).toBe(isInternalRequest);
    });
  });

;

  describe('computeCronSignature', () => {
    it('given valid inputs, should produce deterministic HMAC', () => {
      const sig1 = computeCronSignature('secret', '1000', 'nonce-1', 'POST', '/api/cron/test');
      const sig2 = computeCronSignature('secret', '1000', 'nonce-1', 'POST', '/api/cron/test');
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it('given different paths, should produce different signatures', () => {
      const sig1 = computeCronSignature('secret', '1000', 'nonce-1', 'POST', '/api/cron/test');
      const sig2 = computeCronSignature('secret', '1000', 'nonce-1', 'POST', '/api/memory/cron');
      expect(sig1).not.toBe(sig2);
    });

    it('given different secrets, should produce different signatures', () => {
      const sig1 = computeCronSignature('secret-a', '1000', 'nonce-1', 'POST', '/api/cron/test');
      const sig2 = computeCronSignature('secret-b', '1000', 'nonce-1', 'POST', '/api/cron/test');
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('checkAndRecordNonce', () => {
    beforeEach(() => {
      _resetNonceStore();
    });

    it('given new nonce, should accept', () => {
      expect(checkAndRecordNonce('unique-nonce-1')).toBe(true);
    });

    it('given repeated nonce, should reject', () => {
      checkAndRecordNonce('nonce-repeat');
      expect(checkAndRecordNonce('nonce-repeat')).toBe(false);
    });

    it('given different nonces, should accept both', () => {
      expect(checkAndRecordNonce('nonce-a')).toBe(true);
      expect(checkAndRecordNonce('nonce-b')).toBe(true);
    });
  });

  describe('validateSignedCronRequest', () => {
    const originalEnv = process.env;
    const TEST_SECRET = 'test-hmac-cron-secret';

    beforeEach(() => {
      process.env = { ...originalEnv };
      process.env.CRON_SECRET = TEST_SECRET;
      _resetNonceStore();
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    function createSignedRequest(overrides: {
      timestamp?: string;
      nonce?: string;
      method?: string;
      path?: string;
      host?: string;
      secret?: string;
      omitHeaders?: string[];
    } = {}): Request {
      const method = overrides.method || 'POST';
      const path = overrides.path || '/api/cron/test';
      const host = overrides.host || 'web:3000';
      const timestamp = overrides.timestamp || String(Math.floor(Date.now() / 1000));
      const nonce = overrides.nonce || `nonce-${Math.random()}`;
      const secret = overrides.secret || TEST_SECRET;

      const signature = computeCronSignature(secret, timestamp, nonce, method, path);

      const headers: Record<string, string> = {
        host,
        'x-cron-timestamp': timestamp,
        'x-cron-nonce': nonce,
        'x-cron-signature': signature,
      };

      for (const key of overrides.omitHeaders || []) {
        delete headers[key];
      }

      return new Request(`http://${host}${path}`, { method, headers });
    }

    it('given valid signature + timestamp + nonce + internal, should return null (pass)', () => {
      const request = createSignedRequest();
      expect(validateSignedCronRequest(request)).toBeNull();
    });

    it('given expired timestamp, should return 403', async () => {
      const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago
      const request = createSignedRequest({ timestamp: oldTimestamp });
      const response = validateSignedCronRequest(request);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(403);
      const data = await response!.json();
      expect(data.error).toContain('timestamp');
    });

    it('given replayed nonce, should return 403', async () => {
      const nonce = 'replay-nonce';
      const request1 = createSignedRequest({ nonce });
      expect(validateSignedCronRequest(request1)).toBeNull(); // first should pass

      const request2 = createSignedRequest({ nonce });
      const response = validateSignedCronRequest(request2);
      expect(response).not.toBeNull();
      expect(response!.status).toBe(403);
      const data = await response!.json();
      expect(data.error).toContain('nonce');
    });

    it('given wrong signature, should return 403', async () => {
      const request = createSignedRequest({ secret: 'wrong-secret' });
      const response = validateSignedCronRequest(request);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(403);
      const data = await response!.json();
      expect(data.error).toContain('signature');
    });

    it('given missing headers, should return 403', async () => {
      const request = createSignedRequest({ omitHeaders: ['x-cron-timestamp'] });
      const response = validateSignedCronRequest(request);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(403);
      const data = await response!.json();
      expect(data.error).toContain('missing');
    });

    it('given valid signature but external request, should return 403', async () => {
      const request = createSignedRequest({ host: 'pagespace.ai' });
      const response = validateSignedCronRequest(request);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(403);
      const data = await response!.json();
      expect(data.error).toContain('internal network');
    });

    describe('without CRON_SECRET', () => {
      const originalNodeEnv = process.env.NODE_ENV;

      beforeEach(() => {
        delete process.env.CRON_SECRET;
      });

      afterEach(() => {
        (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
      });

      it('given development mode, should fall back to internal network check', () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
        const request = new Request('http://localhost:3000/api/cron/test', {
          headers: { host: 'localhost:3000' },
        });
        expect(validateSignedCronRequest(request)).toBeNull();
      });

      it('given production mode, should reject request (fail-closed)', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        const request = new Request('http://localhost:3000/api/cron/test', {
          headers: { host: 'localhost:3000' },
        });
        const response = validateSignedCronRequest(request);

        expect(response).not.toBeNull();
        expect(response!.status).toBe(403);

        const data = await response!.json();
        expect(data.error).toContain('CRON_SECRET must be configured in production');
      });

      it('given test mode, should fall back to internal network check', () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
        const request = new Request('http://localhost:3000/api/cron/test', {
          headers: { host: 'localhost:3000' },
        });
        expect(validateSignedCronRequest(request)).toBeNull();
      });
    });
  });
});
