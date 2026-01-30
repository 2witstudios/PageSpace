/**
 * useMobileKeyboard Hook Tests
 * Tests for mobile keyboard state tracking and interaction utilities
 *
 * These tests validate observable behavior:
 * - Hook returns correct keyboard state from DOM
 * - dismiss() triggers blur on iOS Capacitor
 * - Helper functions work correctly
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

type Platform = 'ios' | 'android' | 'web';

// Create hoisted mocks
const { mockIsCapacitorApp, mockGetPlatform } = vi.hoisted(() => {
  return {
    mockIsCapacitorApp: vi.fn<() => boolean>(() => false),
    mockGetPlatform: vi.fn<() => Platform>(() => 'web'),
  };
});

// Mock useCapacitor module
vi.mock('../useCapacitor', () => ({
  isCapacitorApp: () => mockIsCapacitorApp(),
  getPlatform: () => mockGetPlatform(),
}));

// Import after mocks
import {
  useMobileKeyboard,
  dismissKeyboard,
  getKeyboardHeight,
  isKeyboardOpen,
} from '../useMobileKeyboard';

describe('useMobileKeyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mocks to default values
    mockIsCapacitorApp.mockReturnValue(false);
    mockGetPlatform.mockReturnValue('web');

    // Clear any keyboard-related classes and styles
    document.body.classList.remove('keyboard-open');
    document.body.style.removeProperty('--keyboard-height');
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.classList.remove('keyboard-open');
    document.body.style.removeProperty('--keyboard-height');
  });

  describe('initial state', () => {
    it('given no keyboard class on body, should return isOpen=false', () => {
      const { result } = renderHook(() => useMobileKeyboard());

      expect(result.current.isOpen).toBe(false);
    });

    it('given no --keyboard-height CSS variable, should return height=0', () => {
      const { result } = renderHook(() => useMobileKeyboard());

      expect(result.current.height).toBe(0);
    });

    it('given keyboard-open class on body, should return isOpen=true', () => {
      document.body.classList.add('keyboard-open');

      const { result } = renderHook(() => useMobileKeyboard());

      expect(result.current.isOpen).toBe(true);
    });

    it('given --keyboard-height CSS variable, should return height value', () => {
      document.body.style.setProperty('--keyboard-height', '300px');

      const { result } = renderHook(() => useMobileKeyboard());

      expect(result.current.height).toBe(300);
    });
  });

  describe('state updates via MutationObserver', () => {
    it('given class added to body, should update isOpen', async () => {
      const { result } = renderHook(() => useMobileKeyboard());

      expect(result.current.isOpen).toBe(false);

      await act(async () => {
        document.body.classList.add('keyboard-open');
        // Wait for MutationObserver to trigger
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(result.current.isOpen).toBe(true);
    });

    it('given style change on body, should update height', async () => {
      const { result } = renderHook(() => useMobileKeyboard());

      expect(result.current.height).toBe(0);

      await act(async () => {
        document.body.style.setProperty('--keyboard-height', '250px');
        // Wait for MutationObserver to trigger
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(result.current.height).toBe(250);
    });
  });

  describe('dismiss', () => {
    it('given not on iOS Capacitor, should not blur active element', () => {
      mockIsCapacitorApp.mockReturnValue(false);
      mockGetPlatform.mockReturnValue('web');

      // Create a focusable element
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      const blurSpy = vi.spyOn(input, 'blur');

      const { result } = renderHook(() => useMobileKeyboard());

      act(() => {
        result.current.dismiss();
      });

      expect(blurSpy).not.toHaveBeenCalled();

      // Cleanup
      document.body.removeChild(input);
    });

    it('given on iOS Capacitor, should blur active element', () => {
      mockIsCapacitorApp.mockReturnValue(true);
      mockGetPlatform.mockReturnValue('ios');

      // Create a focusable element
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      const blurSpy = vi.spyOn(input, 'blur');

      const { result } = renderHook(() => useMobileKeyboard());

      act(() => {
        result.current.dismiss();
      });

      expect(blurSpy).toHaveBeenCalled();

      // Cleanup
      document.body.removeChild(input);
    });

    it('given on Android Capacitor, should not blur active element', () => {
      mockIsCapacitorApp.mockReturnValue(true);
      mockGetPlatform.mockReturnValue('android');

      // Create a focusable element
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      const blurSpy = vi.spyOn(input, 'blur');

      const { result } = renderHook(() => useMobileKeyboard());

      act(() => {
        result.current.dismiss();
      });

      expect(blurSpy).not.toHaveBeenCalled();

      // Cleanup
      document.body.removeChild(input);
    });
  });

  describe('scrollInputIntoView', () => {
    it('given keyboard not open, should not call scrollIntoView', () => {
      const { result } = renderHook(() => useMobileKeyboard());

      const element = document.createElement('input');
      element.scrollIntoView = vi.fn();

      act(() => {
        result.current.scrollInputIntoView(element);
      });

      expect(element.scrollIntoView).not.toHaveBeenCalled();
    });

    it('given keyboard open with height, should call scrollIntoView', async () => {
      document.body.classList.add('keyboard-open');
      document.body.style.setProperty('--keyboard-height', '300px');

      const { result } = renderHook(() => useMobileKeyboard());

      const element = document.createElement('input');
      element.scrollIntoView = vi.fn();

      act(() => {
        result.current.scrollInputIntoView(element);
      });

      expect(element.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'center',
      });
    });
  });
});

describe('dismissKeyboard (standalone function)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCapacitorApp.mockReturnValue(false);
    mockGetPlatform.mockReturnValue('web');
  });

  it('given not on iOS Capacitor, should not blur active element', () => {
    mockIsCapacitorApp.mockReturnValue(false);
    mockGetPlatform.mockReturnValue('web');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const blurSpy = vi.spyOn(input, 'blur');

    dismissKeyboard();

    expect(blurSpy).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it('given on iOS Capacitor, should blur active element', () => {
    mockIsCapacitorApp.mockReturnValue(true);
    mockGetPlatform.mockReturnValue('ios');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const blurSpy = vi.spyOn(input, 'blur');

    dismissKeyboard();

    expect(blurSpy).toHaveBeenCalled();

    document.body.removeChild(input);
  });
});

describe('getKeyboardHeight (standalone function)', () => {
  beforeEach(() => {
    document.body.style.removeProperty('--keyboard-height');
  });

  afterEach(() => {
    document.body.style.removeProperty('--keyboard-height');
  });

  it('given no --keyboard-height CSS variable, should return 0', () => {
    expect(getKeyboardHeight()).toBe(0);
  });

  it('given --keyboard-height CSS variable, should return height value', () => {
    document.body.style.setProperty('--keyboard-height', '320px');

    expect(getKeyboardHeight()).toBe(320);
  });

  it('given invalid --keyboard-height value, should return 0', () => {
    document.body.style.setProperty('--keyboard-height', 'invalid');

    expect(getKeyboardHeight()).toBe(0);
  });
});

describe('isKeyboardOpen (standalone function)', () => {
  beforeEach(() => {
    document.body.classList.remove('keyboard-open');
  });

  afterEach(() => {
    document.body.classList.remove('keyboard-open');
  });

  it('given no keyboard-open class, should return false', () => {
    expect(isKeyboardOpen()).toBe(false);
  });

  it('given keyboard-open class present, should return true', () => {
    document.body.classList.add('keyboard-open');

    expect(isKeyboardOpen()).toBe(true);
  });
});
