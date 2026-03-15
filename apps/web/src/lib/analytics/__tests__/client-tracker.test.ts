import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock auth-fetch ───────────────────────────────────────────────────────────
// vi.mock is hoisted — use inline vi.fn() in factory
vi.mock('../../auth/auth-fetch', () => ({
  post: vi.fn(),
}));

// ── Import under test ─────────────────────────────────────────────────────────
import {
  track,
  trackPageView,
  trackFeature,
  trackAction,
  trackClick,
  trackSearch,
  trackError,
  trackTiming,
} from '../client-tracker';
import { post } from '../../auth/auth-fetch';

const mockPost = post as ReturnType<typeof vi.fn>;

describe('client-tracker', () => {
  let sendBeaconSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom does not implement sendBeacon — install it manually
    if (!('sendBeacon' in navigator)) {
      Object.defineProperty(navigator, 'sendBeacon', {
        writable: true,
        configurable: true,
        value: vi.fn().mockReturnValue(true),
      });
    }
    sendBeaconSpy = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true) as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── track ─────────────────────────────────────────────────────────────────

  describe('track', () => {
    it('should call sendBeacon with the track endpoint', () => {
      track('test_event');
      expect(sendBeaconSpy).toHaveBeenCalledWith('/api/track', expect.any(String));
    });

    it('should include event name in the payload', () => {
      track('my_event', { key: 'value' });
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.event).toBe('my_event');
    });

    it('should include data in the payload', () => {
      track('test', { foo: 'bar', count: 42 });
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data).toEqual({ foo: 'bar', count: 42 });
    });

    it('should include a timestamp in ISO format', () => {
      track('test');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should fall back to fetch (post) when sendBeacon is unavailable', async () => {
      // Remove sendBeacon from navigator
      const originalSendBeacon = (navigator as Navigator & { sendBeacon?: unknown }).sendBeacon;
      delete (navigator as Navigator & { sendBeacon?: unknown }).sendBeacon;

      mockPost.mockResolvedValueOnce({});

      track('test_event');

      // Wait for the async sendFetch to execute
      await vi.waitFor(() => {
        expect(mockPost).toHaveBeenCalledWith(
          '/api/track',
          expect.objectContaining({ event: 'test_event' })
        );
      });

      (navigator as Navigator & { sendBeacon?: unknown }).sendBeacon = originalSendBeacon;
    });
  });

  // ── trackPageView ─────────────────────────────────────────────────────────

  describe('trackPageView', () => {
    it('should track a page_view event', () => {
      trackPageView('/my/path');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.event).toBe('page_view');
    });

    it('should include path in page_view data', () => {
      trackPageView('/dashboard');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data.path).toBe('/dashboard');
    });

    it('should include provided title', () => {
      trackPageView('/home', 'Home Page');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data.title).toBe('Home Page');
    });

    it('should include screen dimensions', () => {
      trackPageView('/');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data).toHaveProperty('screenWidth');
      expect(payload.data).toHaveProperty('screenHeight');
    });

    it('should include referrer', () => {
      trackPageView('/');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data).toHaveProperty('referrer');
    });
  });

  // ── trackFeature ──────────────────────────────────────────────────────────

  describe('trackFeature', () => {
    it('should track a feature_used event', () => {
      trackFeature('markdown-editor');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.event).toBe('feature_used');
    });

    it('should include feature name in data', () => {
      trackFeature('ai-chat');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data.feature).toBe('ai-chat');
    });

    it('should spread additional metadata into data', () => {
      trackFeature('search', { query: 'hello' });
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data.query).toBe('hello');
    });
  });

  // ── trackAction ───────────────────────────────────────────────────────────

  describe('trackAction', () => {
    it('should track a user_action event', () => {
      trackAction('create', 'page', 'page-123');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.event).toBe('user_action');
    });

    it('should include action, resource, and resourceId', () => {
      trackAction('delete', 'drive', 'drive-456');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data.action).toBe('delete');
      expect(payload.data.resource).toBe('drive');
      expect(payload.data.resourceId).toBe('drive-456');
    });

    it('should handle optional parameters', () => {
      trackAction('view');
      expect(sendBeaconSpy).toHaveBeenCalled();
    });
  });

  // ── trackClick ────────────────────────────────────────────────────────────

  describe('trackClick', () => {
    it('should track a click event', () => {
      trackClick('submit-button');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.event).toBe('click');
    });

    it('should include element name in data', () => {
      trackClick('nav-link');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data.element).toBe('nav-link');
    });
  });

  // ── trackSearch ───────────────────────────────────────────────────────────

  describe('trackSearch', () => {
    it('should track a search event', () => {
      trackSearch('hello world');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.event).toBe('search');
    });

    it('should truncate query to 100 chars', () => {
      const longQuery = 'a'.repeat(200);
      trackSearch(longQuery);
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data.query.length).toBeLessThanOrEqual(100);
    });

    it('should include resultCount and searchType', () => {
      trackSearch('test', 42, 'global');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data.resultCount).toBe(42);
      expect(payload.data.type).toBe('global');
    });
  });

  // ── trackError ────────────────────────────────────────────────────────────

  describe('trackError', () => {
    it('should track a client_error event', () => {
      trackError('Something went wrong');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.event).toBe('client_error');
    });

    it('should truncate error message to 200 chars', () => {
      const longMessage = 'e'.repeat(500);
      trackError(longMessage);
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data.message.length).toBeLessThanOrEqual(200);
    });

    it('should include errorType and context', () => {
      trackError('Failed', 'NetworkError', { url: 'https://example.com' });
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data.type).toBe('NetworkError');
      expect(payload.data.context).toEqual({ url: 'https://example.com' });
    });

    it('should include url and userAgent', () => {
      trackError('oops');
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.data).toHaveProperty('url');
      expect(payload.data).toHaveProperty('userAgent');
    });
  });

  // ── trackTiming ───────────────────────────────────────────────────────────

  describe('trackTiming', () => {
    it('should NOT track when duration is below 3000ms', () => {
      trackTiming('api', 'request', 1000);
      expect(sendBeaconSpy).not.toHaveBeenCalled();
    });

    it('should NOT track when duration equals 3000ms', () => {
      trackTiming('api', 'request', 3000);
      expect(sendBeaconSpy).not.toHaveBeenCalled();
    });

    it('should track when duration exceeds 3000ms', () => {
      trackTiming('api', 'request', 3001);
      expect(sendBeaconSpy).toHaveBeenCalled();
    });

    it('should include timing data in payload', () => {
      trackTiming('render', 'page', 5000);
      const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string);
      expect(payload.event).toBe('timing');
      expect(payload.data.category).toBe('render');
      expect(payload.data.variable).toBe('page');
      expect(payload.data.duration).toBe(5000);
      expect(payload.data.slow).toBe(true);
    });
  });
});
