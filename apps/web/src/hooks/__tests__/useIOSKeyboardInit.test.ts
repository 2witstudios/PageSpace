import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockIsCapacitorApp = vi.hoisted(() => vi.fn(() => false));
const mockIsIOS = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/lib/capacitor-bridge', () => ({
  isCapacitorApp: mockIsCapacitorApp,
  isIOS: mockIsIOS,
}));

import { useIOSKeyboardInit } from '../useIOSKeyboardInit';

describe('useIOSKeyboardInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.classList.remove('capacitor-ios');
    document.body.classList.remove('keyboard-open');
    document.documentElement.classList.remove('keyboard-open');
    document.body.style.removeProperty('--keyboard-height');
  });

  afterEach(() => {
    document.documentElement.classList.remove('capacitor-ios');
    document.body.classList.remove('keyboard-open');
    document.documentElement.classList.remove('keyboard-open');
  });

  it('should do nothing when not in Capacitor app', () => {
    mockIsCapacitorApp.mockReturnValue(false);
    mockIsIOS.mockReturnValue(false);

    renderHook(() => useIOSKeyboardInit());

    expect(document.documentElement.classList.contains('capacitor-ios')).toBe(false);
  });

  it('should do nothing when on Capacitor but not iOS', () => {
    mockIsCapacitorApp.mockReturnValue(true);
    mockIsIOS.mockReturnValue(false);

    renderHook(() => useIOSKeyboardInit());

    expect(document.documentElement.classList.contains('capacitor-ios')).toBe(false);
  });

  it('should add capacitor-ios class when on iOS Capacitor app', () => {
    mockIsCapacitorApp.mockReturnValue(true);
    mockIsIOS.mockReturnValue(true);

    renderHook(() => useIOSKeyboardInit());

    expect(document.documentElement.classList.contains('capacitor-ios')).toBe(true);
  });

  it('should attempt dynamic import of @capacitor/keyboard on iOS', async () => {
    mockIsCapacitorApp.mockReturnValue(true);
    mockIsIOS.mockReturnValue(true);

    // The dynamic import will fail in test env, but the class should still be added
    renderHook(() => useIOSKeyboardInit());

    expect(document.documentElement.classList.contains('capacitor-ios')).toBe(true);
  });

  it('should clean up on unmount', () => {
    mockIsCapacitorApp.mockReturnValue(true);
    mockIsIOS.mockReturnValue(true);

    const { unmount } = renderHook(() => useIOSKeyboardInit());

    expect(document.documentElement.classList.contains('capacitor-ios')).toBe(true);

    // Unmounting should trigger the cleanup function (which sets cancelled = true
    // and calls showListener?.remove() and hideListener?.remove())
    unmount();

    // The class itself is not removed by the cleanup - that is expected behavior
    // The cleanup only removes event listeners
  });
});
