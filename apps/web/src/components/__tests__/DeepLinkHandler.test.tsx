import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const {
  mockPush,
  mockAddListener,
  mockGetLaunchUrl,
  mockRemove,
  mockOpenExternalUrl,
  mockIsCapacitorApp,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockAddListener: vi.fn(),
  mockGetLaunchUrl: vi.fn(),
  mockRemove: vi.fn(),
  mockOpenExternalUrl: vi.fn(),
  mockIsCapacitorApp: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

// Spread the real module: other imports pull getPlatform etc. from here.
vi.mock('@/lib/capacitor-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/capacitor-bridge')>()),
  isCapacitorApp: () => mockIsCapacitorApp(),
}));

vi.mock('@/lib/navigation/app-navigation', () => ({ openExternalUrl: mockOpenExternalUrl }));

vi.mock('@capacitor/app', () => ({
  App: { getLaunchUrl: mockGetLaunchUrl, addListener: mockAddListener },
}));

import { DeepLinkHandler } from '../DeepLinkHandler';

/** Hand back the `appUrlOpen` handler the component registered. */
function warmStartHandler(): (event: { url: string }) => void {
  const call = mockAddListener.mock.calls.find(([event]) => event === 'appUrlOpen');
  if (!call) throw new Error('no appUrlOpen listener was registered');
  return call[1] as (event: { url: string }) => void;
}

describe('DeepLinkHandler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIsCapacitorApp.mockReturnValue(true);
    mockGetLaunchUrl.mockResolvedValue(null);
    mockAddListener.mockResolvedValue({ remove: mockRemove });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes the launch URL on a cold start', async () => {
    // The launch URL is already spent by mount time, so a listener alone would
    // never see it.
    mockGetLaunchUrl.mockResolvedValue({ url: 'https://pagespace.ai/invite/cold' });
    render(<DeepLinkHandler />);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/invite/cold'));
  });

  it('routes a link that arrives while already running', async () => {
    render(<DeepLinkHandler />);
    await waitFor(() => expect(mockAddListener).toHaveBeenCalled());
    warmStartHandler()({ url: 'https://pagespace.ai/invite/warm' });
    expect(mockPush).toHaveBeenCalledWith('/invite/warm');
  });

  it('registers the warm-start listener even when there is no launch URL', async () => {
    render(<DeepLinkHandler />);
    await waitFor(() =>
      expect(mockAddListener).toHaveBeenCalledWith('appUrlOpen', expect.any(Function)),
    );
  });

  it('hands an unrouted claimed URL to the browser instead of swallowing it', async () => {
    render(<DeepLinkHandler />);
    await waitFor(() => expect(mockAddListener).toHaveBeenCalled());
    warmStartHandler()({ url: 'https://pagespace.ai/pricing' });
    expect(mockOpenExternalUrl).toHaveBeenCalledWith('https://pagespace.ai/pricing');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('ignores a URL from another host', async () => {
    render(<DeepLinkHandler />);
    await waitFor(() => expect(mockAddListener).toHaveBeenCalled());
    warmStartHandler()({ url: 'https://evil.example/invite/x' });
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it('does nothing at all on web', async () => {
    mockIsCapacitorApp.mockReturnValue(false);
    render(<DeepLinkHandler />);
    await waitFor(() => expect(mockGetLaunchUrl).not.toHaveBeenCalled());
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', async () => {
    const { unmount } = render(<DeepLinkHandler />);
    await waitFor(() => expect(mockAddListener).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(mockRemove).toHaveBeenCalled());
  });

  it('survives the plugin failing to load', async () => {
    mockGetLaunchUrl.mockRejectedValue(new Error('plugin unavailable'));
    expect(() => render(<DeepLinkHandler />)).not.toThrow();
    await waitFor(() => expect(mockGetLaunchUrl).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalled();
  });
});
