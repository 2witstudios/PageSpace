import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST, PUT } from '../route';

/**
 * /api/track Endpoint Contract Tests
 *
 * This endpoint handles client-side analytics events (fire-and-forget).
 *
 * Contract:
 *   Request: POST with tracking event payload
 *   Response:
 *     200: { ok: true } - Event tracked successfully
 *     400: { error: string } - Invalid schema
 *     413: { error: string } - Payload too large
 *     429: { error: string } - Rate limit exceeded
 *
 * Security Properties:
 *   - No authentication required (public endpoint)
 *   - Rate limited: 100 requests/minute per IP
 *   - Payload size cap: 10KB
 *   - Schema validation: only known event types accepted
 */

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackActivity: vi.fn(),
  trackFeature: vi.fn(),
  trackError: vi.fn(),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    TRACKING: { maxAttempts: 100, windowMs: 60000 },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/auth/auth-helpers', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { trackActivity, trackFeature, trackError } from '@pagespace/lib/activity-tracker';

const createRequest = (body: object, headers?: Record<string, string>) => {
  const bodyStr = JSON.stringify(body);
  return new Request('http://localhost/api/track', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
      ...headers,
    },
    body: bodyStr,
  });
};

describe('/api/track', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
  });

  describe('successful tracking', () => {
    const frozenDate = new Date('2025-01-15T12:00:00.000Z');

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(frozenDate);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('POST_withValidPageView_returns200', async () => {
      const request = createRequest({ event: 'page_view', data: { path: '/home' } });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it('POST_withValidPageView_callsTrackActivity', async () => {
      const request = createRequest({ event: 'page_view', data: { path: '/home' } });
      await POST(request);

      expect(trackActivity).toHaveBeenCalledWith(
        undefined,
        'page_view',
        {
          metadata: { path: '/home', ip: '127.0.0.1', userAgent: 'unknown', timestamp: frozenDate.toISOString() },
          ip: '127.0.0.1',
          userAgent: 'unknown',
        }
      );
    });

    it('POST_withFeatureUsed_callsTrackFeature', async () => {
      const request = createRequest({ event: 'feature_used', data: { feature: 'dark-mode' } });
      await POST(request);

      expect(trackFeature).toHaveBeenCalledWith(
        undefined,
        'dark-mode',
        { feature: 'dark-mode', ip: '127.0.0.1', userAgent: 'unknown', timestamp: frozenDate.toISOString() }
      );
    });

    it('POST_withClientError_callsTrackError', async () => {
      const request = createRequest({
        event: 'client_error',
        data: { type: 'js', message: 'Uncaught TypeError' },
      });
      await POST(request);

      expect(trackError).toHaveBeenCalledWith(
        undefined,
        'js',
        'Uncaught TypeError',
        { type: 'js', message: 'Uncaught TypeError', ip: '127.0.0.1', userAgent: 'unknown', timestamp: frozenDate.toISOString() }
      );
    });

    it('POST_withClickEvent_returns200', async () => {
      const request = createRequest({ event: 'click', data: { label: 'nav-button' } });
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(trackActivity).toHaveBeenCalledWith(
        undefined,
        'ui_click',
        {
          metadata: { label: 'nav-button', ip: '127.0.0.1', userAgent: 'unknown', timestamp: frozenDate.toISOString() },
          ip: '127.0.0.1',
          userAgent: 'unknown',
        }
      );
    });

    it('POST_withEventOnly_returns200', async () => {
      const request = createRequest({ event: 'search' });
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(trackActivity).toHaveBeenCalledWith(
        undefined,
        'search',
        {
          metadata: { ip: '127.0.0.1', userAgent: 'unknown', timestamp: frozenDate.toISOString() },
          ip: '127.0.0.1',
          userAgent: 'unknown',
        }
      );
    });
  });

  describe('rate limiting (429)', () => {
    it('POST_whenRateLimitExceeded_returns429', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        retryAfter: 30,
      });

      const request = createRequest({ event: 'page_view' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many');
      expect(response.headers.get('Retry-After')).toBe('30');
    });

    it('POST_whenRateLimitExceeded_doesNotTrack', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        retryAfter: 30,
      });

      const request = createRequest({ event: 'page_view' });
      await POST(request);

      expect(trackActivity).not.toHaveBeenCalled();
    });
  });

  describe('payload size enforcement (413)', () => {
    it('POST_withOversizedPayload_returns413', async () => {
      const largeData = { event: 'page_view' as const, data: { path: 'x'.repeat(15000) } };
      const request = createRequest(largeData);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body.error).toContain('Payload too large');
    });

    it('POST_withOversizedContentLength_returns413', async () => {
      const request = createRequest(
        { event: 'page_view' },
        { 'Content-Length': '20000' }
      );
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body.error).toContain('Payload too large');
    });
  });

  describe('schema validation (400)', () => {
    it('POST_withUnknownEvent_returns400', async () => {
      const bodyStr = JSON.stringify({ event: 'unknown_event_type' });
      const request = new Request('http://localhost/api/track', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(bodyStr)),
        },
        body: bodyStr,
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid tracking payload');
    });

    it('POST_withMissingEvent_returns400', async () => {
      const bodyStr = JSON.stringify({ data: { path: '/home' } });
      const request = new Request('http://localhost/api/track', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(bodyStr)),
        },
        body: bodyStr,
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid tracking payload');
    });

    it('POST_withInvalidJSON_returnsSilentSuccess', async () => {
      const request = new Request('http://localhost/api/track', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '12',
        },
        body: 'not valid json',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });

  describe('PUT (beacon API)', () => {
    it('PUT_withValidPayload_returns200', async () => {
      const bodyStr = JSON.stringify({ event: 'page_view', data: { path: '/exit' } });
      const request = new Request('http://localhost/api/track', {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(Buffer.byteLength(bodyStr)),
        },
        body: bodyStr,
      });
      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it('PUT_withOversizedPayload_returns413', async () => {
      const bodyStr = JSON.stringify({ event: 'page_view', data: { path: 'x'.repeat(15000) } });
      const request = new Request('http://localhost/api/track', {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: bodyStr,
      });
      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body.error).toContain('Payload too large');
    });
  });
});
