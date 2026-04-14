import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
}));

vi.mock('@/hooks/useCSRFToken', () => ({
  useCSRFToken: () => ({ csrfToken: 'csrf-token-value' }),
}));

vi.mock('@/lib/desktop-auth', () => ({
  isDesktopPlatform: vi.fn(),
  getDevicePlatformFields: vi.fn(),
}));

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

const swrMutateMock = vi.fn();
vi.mock('swr', async () => {
  const actual = await vi.importActual<typeof import('swr')>('swr');
  return {
    ...actual,
    default: () => ({
      data: { passkeys: [] },
      error: null,
      isLoading: false,
      mutate: vi.fn(),
    }),
    mutate: (...args: unknown[]) => swrMutateMock(...args),
  };
});

import { PasskeyManager } from '../PasskeyManager';
import { startRegistration } from '@simplewebauthn/browser';
import { isDesktopPlatform, getDevicePlatformFields } from '@/lib/desktop-auth';
import { toast } from 'sonner';

type PasskeyBridge = {
  isDesktop: boolean;
  auth?: { openExternal?: ReturnType<typeof vi.fn> };
  passkey?: { onRegistered: ReturnType<typeof vi.fn> };
};

function setBridge(bridge: PasskeyBridge | undefined) {
  if (bridge) {
    (window as unknown as { electron: PasskeyBridge }).electron = bridge;
  } else {
    delete (window as unknown as { electron?: PasskeyBridge }).electron;
  }
}

describe('PasskeyManager — desktop external-browser branch', () => {
  let openExternalMock: ReturnType<typeof vi.fn>;
  let onRegisteredMock: ReturnType<typeof vi.fn>;
  let unsubscribeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockReset();

    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    vi.mocked(getDevicePlatformFields).mockResolvedValue({
      platform: 'desktop',
      deviceId: 'device-xyz',
      deviceName: 'Jono Mac',
    });

    openExternalMock = vi.fn().mockResolvedValue({ success: true });
    unsubscribeMock = vi.fn();
    onRegisteredMock = vi.fn().mockReturnValue(unsubscribeMock);

    setBridge({
      isDesktop: true,
      auth: { openExternal: openExternalMock },
      passkey: { onRegistered: onRegisteredMock },
    });

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL('http://localhost:3000/settings/security'),
    });
  });

  afterEach(() => {
    setBridge(undefined);
  });

  it('POSTs handoff then opens the system browser to /auth/passkey-register-external with deviceId + deviceName + handoffToken', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ handoffToken: 'handoff-abc', expiresIn: 300 }),
    });

    render(<PasskeyManager />);

    await userEvent.click(screen.getByRole('button', { name: /add passkey/i }));

    await waitFor(() => expect(openExternalMock).toHaveBeenCalledTimes(1));

    const handoffCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => url === '/api/auth/passkey/register/handoff'
    );
    expect(handoffCall).toBeDefined();
    expect((handoffCall![1] as RequestInit).method).toBe('POST');

    const [url] = openExternalMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/auth/passkey-register-external');
    expect(parsed.searchParams.get('deviceId')).toBe('device-xyz');
    expect(parsed.searchParams.get('deviceName')).toBe('Jono Mac');
    // handoffToken must live in the URL fragment, never in the query, so it
    // is never sent to the server, never logged in access logs/CDNs, and
    // never carried in the Referer header on downstream requests.
    expect(parsed.searchParams.get('handoffToken')).toBeNull();
    expect(parsed.search).not.toContain('handoffToken');
    const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    expect(fragment.get('handoffToken')).toBe('handoff-abc');
  });

  it('does not run the WebAuthn ceremony or call register/options in the Electron window', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ handoffToken: 'handoff-abc', expiresIn: 300 }),
    });

    render(<PasskeyManager />);

    await userEvent.click(screen.getByRole('button', { name: /add passkey/i }));

    await waitFor(() => expect(openExternalMock).toHaveBeenCalled());

    expect(startRegistration).not.toHaveBeenCalled();
    const optionsCalls = fetchWithAuthMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url === '/api/auth/passkey/register/options'
    );
    expect(optionsCalls).toHaveLength(0);
  });

  it('subscribes to passkey:registered and refreshes the passkey list when the deep link returns', async () => {
    render(<PasskeyManager />);

    await waitFor(() => expect(onRegisteredMock).toHaveBeenCalledTimes(1));

    const callback = onRegisteredMock.mock.calls[0][0] as () => void;
    callback();

    expect(swrMutateMock).toHaveBeenCalledWith('/api/auth/passkey');
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/passkey/i));
  });

  it('unsubscribes from passkey:registered on unmount', async () => {
    const { unmount } = render(<PasskeyManager />);
    await waitFor(() => expect(onRegisteredMock).toHaveBeenCalled());
    unmount();
    expect(unsubscribeMock).toHaveBeenCalled();
  });

  it('surfaces an error toast when openExternal rejects and does not run the ceremony', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ handoffToken: 'handoff-abc', expiresIn: 300 }),
    });
    openExternalMock.mockResolvedValueOnce({
      success: false,
      error: 'URL hostname "localhost" is not allowed',
    });

    render(<PasskeyManager />);

    await userEvent.click(screen.getByRole('button', { name: /add passkey/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('not allowed'))
    );
    expect(startRegistration).not.toHaveBeenCalled();
  });
});

describe('PasskeyManager — desktop without IPC bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockReset();

    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    vi.mocked(getDevicePlatformFields).mockResolvedValue({
      platform: 'desktop',
      deviceId: 'device-xyz',
      deviceName: 'Jono Mac',
    });

    setBridge(undefined);
  });

  afterEach(() => {
    setBridge(undefined);
  });

  it('surfaces an update-app error and posts nothing when openExternal is missing', async () => {
    render(<PasskeyManager />);

    await userEvent.click(screen.getByRole('button', { name: /add passkey/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/desktop app/i))
    );

    const passkeyFetchCalls = fetchWithAuthMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/api/auth/passkey')
    );
    expect(passkeyFetchCalls).toHaveLength(0);
    expect(startRegistration).not.toHaveBeenCalled();
  });

  it('does not subscribe to passkey:registered when bridge is missing', async () => {
    render(<PasskeyManager />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /add passkey/i })).toBeInTheDocument()
    );
    expect(swrMutateMock).not.toHaveBeenCalled();
  });
});

describe('PasskeyManager — web path (regression guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockReset();

    vi.mocked(isDesktopPlatform).mockReturnValue(false);
    vi.mocked(getDevicePlatformFields).mockResolvedValue({});
    setBridge(undefined);
  });

  it('still runs the in-browser register ceremony on web (no IPC invoked)', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Failed to start registration' }),
    });

    render(<PasskeyManager />);

    await userEvent.click(screen.getByRole('button', { name: /add passkey/i }));

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/api/auth/passkey/register/options',
        expect.any(Object)
      )
    );
    expect((window as unknown as { electron?: PasskeyBridge }).electron).toBeUndefined();
  });
});
