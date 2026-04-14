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
});
