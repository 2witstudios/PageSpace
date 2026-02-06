import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isLocalhostRequest,
  isInternalRequest,
  hasValidCronSecret,
  validateCronRequest,
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

  describe('hasValidCronSecret', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return false when CRON_SECRET is not set', () => {
      delete process.env.CRON_SECRET;
      const request = new Request('http://localhost:3000/api/cron/test', {
        headers: { authorization: 'Bearer some-secret' },
      });

      expect(hasValidCronSecret(request)).toBe(false);
    });

    it('should return false when no authorization header is present', () => {
      process.env.CRON_SECRET = 'test-secret-value';
      const request = new Request('http://localhost:3000/api/cron/test');

      expect(hasValidCronSecret(request)).toBe(false);
    });

    it('should return false for non-Bearer auth scheme', () => {
      process.env.CRON_SECRET = 'test-secret-value';
      const request = new Request('http://localhost:3000/api/cron/test', {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });

      expect(hasValidCronSecret(request)).toBe(false);
    });

    it('should return false for wrong secret', () => {
      process.env.CRON_SECRET = 'correct-secret';
      const request = new Request('http://localhost:3000/api/cron/test', {
        headers: { authorization: 'Bearer wrong-secret' },
      });

      expect(hasValidCronSecret(request)).toBe(false);
    });

    it('should return false for secret with different length', () => {
      process.env.CRON_SECRET = 'short';
      const request = new Request('http://localhost:3000/api/cron/test', {
        headers: { authorization: 'Bearer much-longer-secret-value' },
      });

      expect(hasValidCronSecret(request)).toBe(false);
    });

    it('should return true for correct secret', () => {
      process.env.CRON_SECRET = 'my-cron-secret-123';
      const request = new Request('http://localhost:3000/api/cron/test', {
        headers: { authorization: 'Bearer my-cron-secret-123' },
      });

      expect(hasValidCronSecret(request)).toBe(true);
    });

    it('should return false for Bearer with no token', () => {
      process.env.CRON_SECRET = 'test-secret';
      const request = new Request('http://localhost:3000/api/cron/test', {
        headers: { authorization: 'Bearer ' },
      });

      expect(hasValidCronSecret(request)).toBe(false);
    });
  });

  describe('validateCronRequest', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    describe('without CRON_SECRET (dev mode)', () => {
      beforeEach(() => {
        delete process.env.CRON_SECRET;
      });

      it('should return null for valid internal request', () => {
        const request = new Request('http://localhost:3000/api/cron/test', {
          headers: { host: 'localhost:3000' },
        });

        expect(validateCronRequest(request)).toBeNull();
      });

      it('should return 403 for external request', async () => {
        const request = new Request('https://pagespace.ai/api/cron/test', {
          headers: { host: 'pagespace.ai' },
        });

        const response = validateCronRequest(request);

        expect(response).not.toBeNull();
        expect(response!.status).toBe(403);

        const data = await response!.json();
        expect(data.error).toContain('internal network');
      });
    });

    describe('with CRON_SECRET (production mode)', () => {
      beforeEach(() => {
        process.env.CRON_SECRET = 'prod-cron-secret-xyz';
      });

      it('should return null when secret is valid and request is internal', () => {
        const request = new Request('http://web:3000/api/cron/test', {
          headers: {
            host: 'web:3000',
            authorization: 'Bearer prod-cron-secret-xyz',
          },
        });

        expect(validateCronRequest(request)).toBeNull();
      });

      it('should return 403 when secret is missing', async () => {
        const request = new Request('http://web:3000/api/cron/test', {
          headers: { host: 'web:3000' },
        });

        const response = validateCronRequest(request);

        expect(response).not.toBeNull();
        expect(response!.status).toBe(403);

        const data = await response!.json();
        expect(data.error).toContain('cron secret');
      });

      it('should return 403 when secret is wrong', async () => {
        const request = new Request('http://web:3000/api/cron/test', {
          headers: {
            host: 'web:3000',
            authorization: 'Bearer wrong-secret',
          },
        });

        const response = validateCronRequest(request);

        expect(response).not.toBeNull();
        expect(response!.status).toBe(403);

        const data = await response!.json();
        expect(data.error).toContain('cron secret');
      });

      it('should return 403 when secret is valid but request is external (defense-in-depth)', async () => {
        const request = new Request('https://pagespace.ai/api/cron/test', {
          headers: {
            host: 'pagespace.ai',
            authorization: 'Bearer prod-cron-secret-xyz',
          },
        });

        const response = validateCronRequest(request);

        expect(response).not.toBeNull();
        expect(response!.status).toBe(403);

        const data = await response!.json();
        expect(data.error).toContain('internal network');
      });

      it('should return 403 when secret is valid but x-forwarded-for is present', async () => {
        const request = new Request('http://localhost:3000/api/cron/test', {
          headers: {
            host: 'localhost:3000',
            authorization: 'Bearer prod-cron-secret-xyz',
            'x-forwarded-for': '203.0.113.195',
          },
        });

        const response = validateCronRequest(request);

        expect(response).not.toBeNull();
        expect(response!.status).toBe(403);

        const data = await response!.json();
        expect(data.error).toContain('internal network');
      });

      it('should return null for localhost with valid secret', () => {
        const request = new Request('http://localhost:3000/api/cron/test', {
          headers: {
            host: 'localhost:3000',
            authorization: 'Bearer prod-cron-secret-xyz',
          },
        });

        expect(validateCronRequest(request)).toBeNull();
      });
    });

    it('should return 403 response for proxied request without CRON_SECRET', async () => {
      delete process.env.CRON_SECRET;
      const request = new Request('http://localhost:3000/api/cron/test', {
        headers: {
          host: 'localhost:3000',
          'x-forwarded-for': '203.0.113.195',
        },
      });

      const response = validateCronRequest(request);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(403);
    });
  });
});
