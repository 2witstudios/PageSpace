import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/capacitor-bridge', () => ({
  isCapacitorApp: vi.fn(),
}));

import {
  isInternalUrl,
  openExternalUrl,
  navigateInternal,
  handleLinkNavigation,
  subscribeToNavigationEvents,
} from '../app-navigation';
import { isCapacitorApp } from '@/lib/capacitor-bridge';

describe('app-navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isInternalUrl', () => {
    it('should return true for relative paths', () => {
      expect(isInternalUrl('/dashboard')).toBe(true);
    });

    it('should return true for same-origin URLs', () => {
      expect(isInternalUrl(window.location.origin + '/test')).toBe(true);
    });

    it('should return false for external URLs', () => {
      expect(isInternalUrl('https://external.com/page')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isInternalUrl('')).toBe(false);
    });
  });

  describe('openExternalUrl', () => {
    it('should use window.open on web platform', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(false);
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      await openExternalUrl('https://example.com');

      expect(openSpy).toHaveBeenCalled();
      expect(openSpy.mock.calls[0][0]).toBe('https://example.com');
      expect(openSpy.mock.calls[0][1]).toBe('_blank');
    });

    it('should fall back to window.open when Capacitor Browser import fails', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      await openExternalUrl('https://example.com');

      expect(openSpy).toHaveBeenCalled();
      expect(openSpy.mock.calls[0][0]).toBe('https://example.com');
      expect(openSpy.mock.calls[0][1]).toBe('_blank');
    });
  });

  describe('navigateInternal', () => {
    it('should call routerPush with URL', () => {
      const push = vi.fn();
      navigateInternal('/dashboard', push);
      expect(push).toHaveBeenCalledWith('/dashboard');
    });
  });

  describe('handleLinkNavigation', () => {
    it('should use router push for internal URLs', async () => {
      const push = vi.fn();
      await handleLinkNavigation('/page', push);
      expect(push).toHaveBeenCalledWith('/page');
    });

    it('should use openExternalUrl for external URLs', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(false);
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      const push = vi.fn();

      await handleLinkNavigation('https://external.com', push);

      expect(push).not.toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalled();
    });
  });

  describe('subscribeToNavigationEvents', () => {
    it('should subscribe to pagespace:navigate events', () => {
      const push = vi.fn();
      const cleanup = subscribeToNavigationEvents(push);

      const event = new CustomEvent('pagespace:navigate', {
        detail: { href: '/test-page' },
      });
      document.dispatchEvent(event);

      expect(push).toHaveBeenCalledWith('/test-page');
      cleanup();
    });

    it('should not call push when href is empty', () => {
      const push = vi.fn();
      const cleanup = subscribeToNavigationEvents(push);

      const event = new CustomEvent('pagespace:navigate', {
        detail: { href: '' },
      });
      document.dispatchEvent(event);

      expect(push).not.toHaveBeenCalled();
      cleanup();
    });

    it('should unsubscribe on cleanup', () => {
      const push = vi.fn();
      const cleanup = subscribeToNavigationEvents(push);
      cleanup();

      const event = new CustomEvent('pagespace:navigate', {
        detail: { href: '/test' },
      });
      document.dispatchEvent(event);

      expect(push).not.toHaveBeenCalled();
    });
  });
});
