import { describe, it, expect } from 'vitest';
import { isLocalhostRequest, isInternalRequest, validateCronRequest } from '../cron-auth';

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

  describe('validateCronRequest', () => {
    it('should return null for valid localhost request', () => {
      const request = new Request('http://localhost:3000/api/cron/test', {
        headers: { host: 'localhost:3000' },
      });

      expect(validateCronRequest(request)).toBeNull();
    });

    it('should return 403 response for external request', async () => {
      const request = new Request('https://pagespace.ai/api/cron/test', {
        headers: { host: 'pagespace.ai' },
      });

      const response = validateCronRequest(request);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(403);

      const data = await response!.json();
      expect(data.error).toContain('localhost');
    });

    it('should return 403 response for proxied request', async () => {
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
