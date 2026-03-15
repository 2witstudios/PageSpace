/**
 * useEnterToSend Hook Tests
 *
 * Tests the Enter-to-send behavior across platforms:
 * - Desktop browser: Enter sends (returns true)
 * - Mobile phone browser (iPhone, Android): Enter = newline (returns false)
 * - Tablet browser (iPad, Android tablet): Enter = newline (returns false)
 * - Native iPad with on-screen keyboard: Enter = newline (returns false)
 * - Native iPad with external keyboard: Enter sends (returns true)
 * - Native phone: Enter = newline (returns false)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockUseCapacitor = vi.hoisted(() =>
  vi.fn(() => ({
    isNative: false,
    isIPad: false,
    isReady: true,
    platform: 'web' as const,
    isIOS: false,
    isAndroid: false,
  }))
);

const mockUseMobileKeyboard = vi.hoisted(() =>
  vi.fn(() => ({
    isOpen: false,
    height: 0,
    dismiss: vi.fn(),
    scrollInputIntoView: vi.fn(),
  }))
);

vi.mock('../useCapacitor', () => ({
  useCapacitor: mockUseCapacitor,
}));

vi.mock('../useMobileKeyboard', () => ({
  useMobileKeyboard: mockUseMobileKeyboard,
}));

import { useEnterToSend } from '../useEnterToSend';

// Helper to set navigator.userAgent
function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', {
    value: ua,
    configurable: true,
    writable: true,
  });
}

// Helper to set navigator.maxTouchPoints
function setMaxTouchPoints(points: number) {
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: points,
    configurable: true,
    writable: true,
  });
}

describe('useEnterToSend', () => {
  const originalUserAgent = navigator.userAgent;
  const originalMaxTouchPoints = navigator.maxTouchPoints;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to desktop defaults
    mockUseCapacitor.mockReturnValue({
      isNative: false,
      isIPad: false,
      isReady: true,
      platform: 'web' as const,
      isIOS: false,
      isAndroid: false,
    });
    mockUseMobileKeyboard.mockReturnValue({
      isOpen: false,
      height: 0,
      dismiss: vi.fn(),
      scrollInputIntoView: vi.fn(),
    });
  });

  afterEach(() => {
    // Restore original userAgent and maxTouchPoints
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: originalMaxTouchPoints,
      configurable: true,
      writable: true,
    });
  });

  describe('desktop browser', () => {
    it('should return true when on a desktop browser', () => {
      setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      setMaxTouchPoints(0);

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(true);
    });

    it('should return true when on a Windows desktop browser', () => {
      setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      setMaxTouchPoints(0);

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(true);
    });
  });

  describe('mobile phone browser', () => {
    it('should return false when on iPhone browser', () => {
      setUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      );

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(false);
    });

    it('should return false when on Android phone browser', () => {
      setUserAgent(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      );

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(false);
    });

    it('should return false when on iPod browser', () => {
      setUserAgent(
        'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
      );

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(false);
    });
  });

  describe('tablet browser', () => {
    it('should return false when on iPad browser', () => {
      setUserAgent(
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      );

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(false);
    });

    it('should return false when on modern iPad reporting as Macintosh with touch', () => {
      setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      );
      setMaxTouchPoints(5);

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(false);
    });

    it('should return false when on Android tablet browser', () => {
      setUserAgent(
        'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(false);
    });
  });

  describe('native Capacitor iPad', () => {
    it('should return false when native iPad with on-screen keyboard (height > 120)', () => {
      mockUseCapacitor.mockReturnValue({
        isNative: true,
        isIPad: true,
        isReady: true,
        platform: 'ios' as const,
        isIOS: true,
        isAndroid: false,
      });
      mockUseMobileKeyboard.mockReturnValue({
        isOpen: true,
        height: 350,
        dismiss: vi.fn(),
        scrollInputIntoView: vi.fn(),
      });

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(false);
    });

    it('should return true when native iPad with external keyboard (no keyboard shown)', () => {
      mockUseCapacitor.mockReturnValue({
        isNative: true,
        isIPad: true,
        isReady: true,
        platform: 'ios' as const,
        isIOS: true,
        isAndroid: false,
      });
      mockUseMobileKeyboard.mockReturnValue({
        isOpen: false,
        height: 0,
        dismiss: vi.fn(),
        scrollInputIntoView: vi.fn(),
      });

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(true);
    });

    it('should return true when native iPad with external keyboard showing small toolbar (height <= 120)', () => {
      mockUseCapacitor.mockReturnValue({
        isNative: true,
        isIPad: true,
        isReady: true,
        platform: 'ios' as const,
        isIOS: true,
        isAndroid: false,
      });
      mockUseMobileKeyboard.mockReturnValue({
        isOpen: true,
        height: 55,
        dismiss: vi.fn(),
        scrollInputIntoView: vi.fn(),
      });

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(true);
    });

    it('should return true when native iPad with keyboard open at exactly threshold (120)', () => {
      mockUseCapacitor.mockReturnValue({
        isNative: true,
        isIPad: true,
        isReady: true,
        platform: 'ios' as const,
        isIOS: true,
        isAndroid: false,
      });
      mockUseMobileKeyboard.mockReturnValue({
        isOpen: true,
        height: 120,
        dismiss: vi.fn(),
        scrollInputIntoView: vi.fn(),
      });

      const { result } = renderHook(() => useEnterToSend());

      // 120 is NOT > 120, so treated as external keyboard
      expect(result.current).toBe(true);
    });
  });

  describe('native Capacitor phone', () => {
    it('should return false when native phone (iOS)', () => {
      mockUseCapacitor.mockReturnValue({
        isNative: true,
        isIPad: false,
        isReady: true,
        platform: 'ios' as const,
        isIOS: true,
        isAndroid: false,
      });

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(false);
    });

    it('should return false when native phone (Android)', () => {
      mockUseCapacitor.mockReturnValue({
        isNative: true,
        isIPad: false,
        isReady: true,
        platform: 'android' as const,
        isIOS: false,
        isAndroid: true,
      });

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(false);
    });
  });

  describe('before Capacitor is ready', () => {
    it('should fall through to UA heuristics when Capacitor is not ready', () => {
      mockUseCapacitor.mockReturnValue({
        isNative: false,
        isIPad: false,
        isReady: false,
        platform: 'web' as const,
        isIOS: false,
        isAndroid: false,
      });
      // Desktop UA
      setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      );
      setMaxTouchPoints(0);

      const { result } = renderHook(() => useEnterToSend());

      expect(result.current).toBe(true);
    });

    it('should detect mobile phone via UA when Capacitor is not ready', () => {
      mockUseCapacitor.mockReturnValue({
        isNative: true,
        isIPad: false,
        isReady: false,
        platform: 'ios' as const,
        isIOS: true,
        isAndroid: false,
      });
      setUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      );

      const { result } = renderHook(() => useEnterToSend());

      // isReady is false, so the native branch is skipped; UA detects iPhone
      expect(result.current).toBe(false);
    });
  });
});
