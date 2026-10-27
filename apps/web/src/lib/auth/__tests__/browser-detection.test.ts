import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockInAppSpy, mockIsCapacitorApp } = vi.hoisted(() => ({
  mockInAppSpy: vi.fn(),
  mockIsCapacitorApp: vi.fn(),
}));

vi.mock('inapp-spy', () => ({ default: mockInAppSpy }));

// Spread the real module: the bridge is imported by other auth helpers that
// need getPlatform et al. to exist.
vi.mock('@/lib/capacitor-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/capacitor-bridge')>()),
  isCapacitorApp: () => mockIsCapacitorApp(),
}));

import { detectInAppBrowser } from '../browser-detection';

describe('detectInAppBrowser', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // inapp-spy flags every bare WKWebView, our own shell included.
    mockInAppSpy.mockReturnValue({ isInApp: true, appName: undefined });
  });

  it('given the Capacitor shell, should not report an in-app browser', () => {
    mockIsCapacitorApp.mockReturnValue(true);

    expect(detectInAppBrowser()).toEqual({ isInApp: false, appName: undefined });
    // The exemption is decided before inapp-spy runs, not by overriding it.
    expect(mockInAppSpy).not.toHaveBeenCalled();
  });

  it('given a genuine third-party in-app browser, should still report it', () => {
    mockIsCapacitorApp.mockReturnValue(false);
    mockInAppSpy.mockReturnValue({ isInApp: true, appName: 'Instagram' });

    expect(detectInAppBrowser()).toEqual({ isInApp: true, appName: 'Instagram' });
  });

  it('given a normal browser, should report not in-app', () => {
    mockIsCapacitorApp.mockReturnValue(false);
    mockInAppSpy.mockReturnValue({ isInApp: false, appName: undefined });

    expect(detectInAppBrowser().isInApp).toBe(false);
  });
});
