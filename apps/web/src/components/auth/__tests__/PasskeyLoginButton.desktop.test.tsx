import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));

vi.mock('@/hooks/useWebAuthnSupport', () => ({
  useWebAuthnSupport: vi.fn(() => true),
}));

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ setAuthFailedPermanently: vi.fn() }),
  },
}));

vi.mock('@/lib/utils/persist-csrf-token', () => ({
  persistCsrfToken: vi.fn(),
}));

vi.mock('@/lib/desktop-auth', () => ({
  isDesktopPlatform: vi.fn(),
  getDevicePlatformFields: vi.fn(),
  handleDesktopAuthResponse: vi.fn(),
}));

// The web path sends a stable per-browser device identity from analytics.
vi.mock('@/lib/analytics', () => ({
  getOrCreateDeviceId: vi.fn(() => 'web-device-id'),
  getDeviceName: vi.fn(() => 'Web Browser'),
}));

import { PasskeyLoginButton } from '../PasskeyLoginButton';
import { startAuthentication } from '@simplewebauthn/browser';
import { isDesktopPlatform, getDevicePlatformFields } from '@/lib/desktop-auth';
import { toast } from 'sonner';

type ElectronBridge = {
  isDesktop: boolean;
  auth: {
    openExternal: ReturnType<typeof vi.fn>;
  };
};

describe('PasskeyLoginButton — desktop external-browser branch', () => {
  let openExternalMock: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    vi.mocked(getDevicePlatformFields).mockResolvedValue({
      platform: 'desktop',
      deviceId: 'device-xyz',
      deviceName: 'Jono Mac',
    });

    openExternalMock = vi.fn().mockResolvedValue({ success: true });
    const bridge: ElectronBridge = {
      isDesktop: true,
      auth: { openExternal: openExternalMock },
    };
    (window as unknown as { electron: ElectronBridge }).electron = bridge;

    // Pin origin so the URL assertion is deterministic. jsdom default is
    // http://localhost:3000 which we still want, but set explicitly.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL('http://localhost:3000/auth/signin'),
    });

    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    delete (window as unknown as { electron?: ElectronBridge }).electron;
  });

  it('opens the system browser to /auth/passkey-external with device fields', async () => {
    render(<PasskeyLoginButton csrfToken="csrf-token-value" />);

    await userEvent.click(screen.getByRole('button', { name: /sign in with passkey/i }));

    expect(openExternalMock).toHaveBeenCalledTimes(1);
    const [url] = openExternalMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/auth/passkey-external');
    expect(parsed.searchParams.get('deviceId')).toBe('device-xyz');
    expect(parsed.searchParams.get('deviceName')).toBe('Jono Mac');
  });

  it('does not run the WebAuthn ceremony in the Electron window', async () => {
    render(<PasskeyLoginButton csrfToken="csrf-token-value" />);

    await userEvent.click(screen.getByRole('button', { name: /sign in with passkey/i }));

    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it('does not fetch passkey authentication options from the Electron window', async () => {
    render(<PasskeyLoginButton csrfToken="csrf-token-value" />);

    await userEvent.click(screen.getByRole('button', { name: /sign in with passkey/i }));

    const callsToAuthOptions = fetchSpy.mock.calls.filter(([url]) =>
      typeof url === 'string' && url.includes('/api/auth/passkey/authenticate/options')
    );
    expect(callsToAuthOptions).toHaveLength(0);
  });

  it('surfaces an error toast if openExternal is rejected by the IPC allowlist', async () => {
    openExternalMock.mockResolvedValueOnce({
      success: false,
      error: 'URL hostname "localhost" is not allowed',
    });

    render(<PasskeyLoginButton csrfToken="csrf-token-value" />);

    await userEvent.click(screen.getByRole('button', { name: /sign in with passkey/i }));

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('not allowed'));
    expect(startAuthentication).not.toHaveBeenCalled();
  });
});

describe('PasskeyLoginButton — desktop without IPC bridge', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    vi.mocked(getDevicePlatformFields).mockResolvedValue({
      platform: 'desktop',
      deviceId: 'device-xyz',
      deviceName: 'Jono Mac',
    });

    delete (window as unknown as { electron?: ElectronBridge }).electron;

    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  it('surfaces an update-app error and posts nothing when openExternal is missing', async () => {
    render(<PasskeyLoginButton csrfToken="csrf-token-value" />);

    await userEvent.click(screen.getByRole('button', { name: /sign in with passkey/i }));

    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/desktop app/i));

    const passkeyFetchCalls = fetchSpy.mock.calls.filter(([url]) =>
      typeof url === 'string' && url.includes('/api/auth/passkey/authenticate')
    );
    expect(passkeyFetchCalls).toHaveLength(0);

    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it('does not fall through to the web ceremony when IPC bridge is missing', async () => {
    (window as unknown as { electron: { isDesktop: boolean; auth: Record<string, never> } }).electron = {
      isDesktop: true,
      auth: {},
    };

    render(<PasskeyLoginButton csrfToken="csrf-token-value" />);

    await userEvent.click(screen.getByRole('button', { name: /sign in with passkey/i }));

    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/desktop app/i));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(startAuthentication).not.toHaveBeenCalled();

    delete (window as unknown as { electron?: ElectronBridge }).electron;
  });
});

describe('PasskeyLoginButton — web path (regression guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDesktopPlatform).mockReturnValue(false);
    vi.mocked(getDevicePlatformFields).mockResolvedValue({});

    delete (window as unknown as { electron?: ElectronBridge }).electron;

    // Web path still calls fetch; mock it to fail fast after options so the
    // test does not rely on the full ceremony plumbing.
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Failed to start authentication' }),
    }) as unknown as typeof fetch;
  });

  it('still runs the in-browser ceremony path on web (no IPC invoked)', async () => {
    const { container } = render(<PasskeyLoginButton csrfToken="csrf-token-value" />);

    await userEvent.click(screen.getByRole('button', { name: /sign in with passkey/i }));

    // On web, fetch IS called (for options), and the IPC bridge is never touched.
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      '/api/auth/passkey/authenticate/options',
      expect.any(Object),
    );
    expect((window as unknown as { electron?: ElectronBridge }).electron).toBeUndefined();
    // Ensure the component actually mounted (sanity check).
    expect(container).toBeTruthy();
  });

  it('sends a stable per-browser device identity in the verify request body', async () => {
    // Full happy-path plumbing so the verify POST actually fires.
    vi.mocked(startAuthentication).mockResolvedValue({ id: 'assertion' } as never);
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ options: { challenge: 'ch', allowCredentials: [{ id: 'cred' }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, redirectUrl: '/dashboard', csrfToken: 'c' }),
      });
    global.fetch = fetchSpy as unknown as typeof fetch;

    render(<PasskeyLoginButton csrfToken="csrf-token-value" onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /sign in with passkey/i }));

    const verifyCall = fetchSpy.mock.calls.find(
      ([url]) => url === '/api/auth/passkey/authenticate',
    );
    expect(verifyCall).toBeDefined();
    const body = JSON.parse((verifyCall![1] as { body: string }).body);
    expect(body.platform).toBe('web');
    expect(body.deviceId).toBe('web-device-id');
    expect(body.deviceName).toBe('Web Browser');
  });

  it('persists the device token the route returns so silent recovery keeps working', async () => {
    vi.mocked(startAuthentication).mockResolvedValue({ id: 'assertion' } as never);
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ options: { challenge: 'ch', allowCredentials: [{ id: 'cred' }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          redirectUrl: '/dashboard',
          csrfToken: 'c',
          deviceToken: 'ps_dev_web_rotated',
        }),
      }) as unknown as typeof fetch;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    render(<PasskeyLoginButton csrfToken="csrf-token-value" onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /sign in with passkey/i }));

    expect(setItemSpy).toHaveBeenCalledWith('deviceToken', 'ps_dev_web_rotated');
    setItemSpy.mockRestore();
  });
});
