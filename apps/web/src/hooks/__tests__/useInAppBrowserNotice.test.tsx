import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { mockDetectInAppBrowser } = vi.hoisted(() => ({
  mockDetectInAppBrowser: vi.fn(),
}));

vi.mock('@/lib/auth/browser-detection', () => ({
  detectInAppBrowser: () => mockDetectInAppBrowser(),
}));

import { useInAppBrowserNotice } from '../useInAppBrowserNotice';

describe('useInAppBrowserNotice', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('given a third-party in-app browser, should surface the notice after mount', async () => {
    mockDetectInAppBrowser.mockReturnValue({ isInApp: true, appName: 'Instagram' });

    const { result } = renderHook(() => useInAppBrowserNotice());

    await waitFor(() => expect(result.current).toEqual({ isInApp: true, appName: 'Instagram' }));
  });

  it('given no in-app browser, should stay quiet', async () => {
    mockDetectInAppBrowser.mockReturnValue({ isInApp: false, appName: undefined });

    const { result } = renderHook(() => useInAppBrowserNotice());

    await waitFor(() => expect(mockDetectInAppBrowser).toHaveBeenCalled());
    expect(result.current).toEqual({ isInApp: false, appName: undefined });
  });
});
