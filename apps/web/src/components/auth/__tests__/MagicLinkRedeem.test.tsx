import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const {
  mockReplace,
  mockIsCapacitorApp,
  mockGetDeviceId,
  mockStoreSession,
  mockClearSession,
  mockSetUser,
  mockSetAuthFailedPermanently,
} = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockIsCapacitorApp: vi.fn(),
  mockGetDeviceId: vi.fn(),
  mockStoreSession: vi.fn(),
  mockClearSession: vi.fn(),
  mockSetUser: vi.fn(),
  mockSetAuthFailedPermanently: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace, push: vi.fn() }) }));

// Spread the real module: other imports pull getPlatform etc. from here.
vi.mock('@/lib/capacitor-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/capacitor-bridge')>()),
  isCapacitorApp: () => mockIsCapacitorApp(),
}));

vi.mock('@/lib/auth/platform-storage', () => ({
  getPlatformStorage: () => ({
    getDeviceId: mockGetDeviceId,
    storeSession: mockStoreSession,
    clearSession: mockClearSession,
  }),
}));

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ setUser: mockSetUser, setAuthFailedPermanently: mockSetAuthFailedPermanently }),
  },
}));

// AuthShell animates with motion/react; keep the DOM plain.
vi.mock('@/components/auth/AuthShell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { MagicLinkRedeem } from '../MagicLinkRedeem';

const okResponse = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const user = { id: 'u1', name: 'Jo', email: 'jo@example.com', image: null, emailVerified: null };

describe('MagicLinkRedeem', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetDeviceId.mockResolvedValue('dev_iphone');
    mockStoreSession.mockResolvedValue(undefined);
    mockClearSession.mockResolvedValue(undefined);
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sentBody = () => {
    const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/api/auth/magic-link/verify'));
    if (!call) throw new Error('verify was never called');
    const init = call[1] as RequestInit;
    return { init, body: JSON.parse(init.body as string) as Record<string, unknown> };
  };

  it('in the app, presents this device, stores the returned tokens in the secure store, and lands the user', async () => {
    mockIsCapacitorApp.mockReturnValue(true);
    fetchSpy.mockResolvedValue(
      okResponse({
        redirectTo: '/dashboard/d1?auth=success',
        isNewUser: false,
        user,
        sessionToken: 'ps_sess_1',
        csrfToken: 'csrf_1',
        deviceToken: 'ps_dev_1',
      }),
    );

    render(<MagicLinkRedeem token="ps_magic_abc" next="/dashboard/d1" />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard/d1?auth=success'));
    const { init, body } = sentBody();
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(body).toEqual({ token: 'ps_magic_abc', next: '/dashboard/d1', deviceId: 'dev_iphone' });
    expect(mockStoreSession).toHaveBeenCalledWith({
      sessionToken: 'ps_sess_1',
      csrfToken: 'csrf_1',
      deviceId: 'dev_iphone',
      deviceToken: 'ps_dev_1',
    });
    expect(mockSetAuthFailedPermanently).toHaveBeenCalledWith(false);
    expect(mockSetUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1', email: 'jo@example.com' }));
    // Store first, then navigate: the dashboard's first request must find the bearer.
    expect(mockStoreSession.mock.invocationCallOrder[0]).toBeLessThan(mockReplace.mock.invocationCallOrder[0]);
  });

  it('in the app, when the server withholds tokens, clears the stale entry and lands on the cookie session', async () => {
    mockIsCapacitorApp.mockReturnValue(true);
    fetchSpy.mockResolvedValue(okResponse({ redirectTo: '/dashboard?auth=success', isNewUser: false, user: null }));

    render(<MagicLinkRedeem token="ps_magic_abc" />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard?auth=success'));
    expect(mockStoreSession).not.toHaveBeenCalled();
    expect(mockSetUser).not.toHaveBeenCalled();
    expect(mockClearSession).toHaveBeenCalled();
  });

  it('in a browser, presents no device and never touches the secure store', async () => {
    mockIsCapacitorApp.mockReturnValue(false);
    fetchSpy.mockResolvedValue(okResponse({ redirectTo: '/dashboard?auth=success', isNewUser: true, user }));

    render(<MagicLinkRedeem token="ps_magic_abc" />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard?auth=success'));
    expect(sentBody().body).toEqual({ token: 'ps_magic_abc' });
    expect(mockGetDeviceId).not.toHaveBeenCalled();
    expect(mockStoreSession).not.toHaveBeenCalled();
  });

  it('on a rejected token, shows the reason and sends the user to sign-in with the same code', async () => {
    mockIsCapacitorApp.mockReturnValue(true);
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'magic_link_expired' }), { status: 401 }),
    );

    render(<MagicLinkRedeem token="ps_magic_abc" />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/signin?error=magic_link_expired'));
    expect(screen.getByText(/expired/i)).toBeInTheDocument();
    expect(mockStoreSession).not.toHaveBeenCalled();
  });

  it('on a network failure, shows actionable copy rather than the raw error', async () => {
    mockIsCapacitorApp.mockReturnValue(false);
    fetchSpy.mockRejectedValue(new Error('Failed to fetch'));

    render(<MagicLinkRedeem token="ps_magic_abc" />);

    await waitFor(() => expect(screen.getByText('Sign-in failed')).toBeInTheDocument());
    expect(screen.getByText(/check your connection/i)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('when the secure store refuses to save, still lands the user on the cookie session', async () => {
    // The token is already spent and the cookie is already set. Stranding the
    // user here would leave them signed out with nothing to retry.
    mockIsCapacitorApp.mockReturnValue(true);
    mockStoreSession.mockRejectedValue(new Error('keychain locked'));
    fetchSpy.mockResolvedValue(
      okResponse({
        redirectTo: '/dashboard?auth=success',
        isNewUser: false,
        user,
        sessionToken: 'ps_sess_1',
        csrfToken: 'csrf_1',
        deviceToken: 'ps_dev_1',
      }),
    );

    render(<MagicLinkRedeem token="ps_magic_abc" />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard?auth=success'));
    expect(screen.queryByText('Sign-in failed')).not.toBeInTheDocument();
    // The old entry must not survive: the server already revoked this device's
    // sessions and rotated its token, and auth-fetch would prefer that stale
    // bearer over the cookie we just received.
    expect(mockClearSession).toHaveBeenCalled();
  });

  it('when the device id cannot be read, falls back to the cookie-only path instead of failing', async () => {
    mockIsCapacitorApp.mockReturnValue(true);
    mockGetDeviceId.mockRejectedValue(new Error('preferences unavailable'));
    fetchSpy.mockResolvedValue(okResponse({ redirectTo: '/dashboard?auth=success', isNewUser: false, user: null }));

    render(<MagicLinkRedeem token="ps_magic_abc" />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard?auth=success'));
    expect(sentBody().body).toEqual({ token: 'ps_magic_abc' });
    expect(mockStoreSession).not.toHaveBeenCalled();
  });

  it('redeems exactly once across React strict-mode double effects', async () => {
    // Rendered inside StrictMode on purpose: RTL does not add it, and without
    // it this test passes with the `started` guard deleted — which is exactly
    // the guard that keeps a single-use token from being spent twice.
    mockIsCapacitorApp.mockReturnValue(false);
    fetchSpy.mockResolvedValue(okResponse({ redirectTo: '/dashboard?auth=success', isNewUser: false, user: null }));

    render(
      <StrictMode>
        <MagicLinkRedeem token="ps_magic_abc" />
      </StrictMode>,
    );

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('offers a retry after a transient failure, because reopening the link cannot retry', async () => {
    // DeepLinkHandler remembers the URL it already handled, so tapping the
    // same link again in the same app run does nothing. The retry has to be
    // on this page or the user has to restart the app.
    mockIsCapacitorApp.mockReturnValue(false);
    fetchSpy.mockRejectedValueOnce(new Error('Failed to fetch'));
    fetchSpy.mockResolvedValueOnce(
      okResponse({ redirectTo: '/dashboard?auth=success', isNewUser: false, user: null }),
    );

    render(<MagicLinkRedeem token="ps_magic_abc" />);

    const retry = await screen.findByRole('button', { name: /try again/i });
    await userEvent.click(retry);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard?auth=success'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('offers a retry when the server fails on its own side', async () => {
    mockIsCapacitorApp.mockReturnValue(false);
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'server_error' }), { status: 500 }),
    );

    render(<MagicLinkRedeem token="ps_magic_abc" />);

    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByText(/on our end/i)).toBeInTheDocument();
    // A server fault says nothing about the link, so do not send the user off
    // to request a replacement.
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('offers no retry once the token is spent — only a fresh link will do', async () => {
    mockIsCapacitorApp.mockReturnValue(false);
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'magic_link_used' }), { status: 401 }),
    );

    render(<MagicLinkRedeem token="ps_magic_abc" />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/signin?error=magic_link_used'));
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });
});
