import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const webContents = {
    send: vi.fn(),
  };
  const mainWindow = {
    webContents,
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn(),
  };
  return { webContents, mainWindow };
});

vi.mock('electron', () => ({
  app: {
    setAsDefaultProtocolClient: vi.fn(),
  },
  session: {
    defaultSession: {
      cookies: {
        set: vi.fn(async () => undefined),
      },
    },
  },
}));

vi.mock('../state', () => ({
  mainWindow: mocks.mainWindow,
  setCachedSession: vi.fn(),
}));

vi.mock('../auth-storage', () => ({
  saveAuthSession: vi.fn(async () => undefined),
}));

vi.mock('../app-url', () => ({
  getAppUrl: vi.fn(() => 'https://pagespace.ai/dashboard'),
}));

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { handleDeepLink } from '../deep-links';

describe('handleDeepLink dispatcher', () => {
  beforeEach(() => {
    mocks.webContents.send.mockReset();
    mocks.mainWindow.focus.mockReset();
    mocks.mainWindow.show.mockReset();
    mocks.mainWindow.restore.mockReset();
    mocks.mainWindow.isMinimized.mockReset().mockReturnValue(false);
    mocks.mainWindow.loadURL.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('given pagespace://passkey-registered', () => {
    it('should focus the main window and broadcast passkey:registered without any HTTP call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await handleDeepLink('pagespace://passkey-registered');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mocks.mainWindow.focus).toHaveBeenCalledTimes(1);
      expect(mocks.webContents.send).toHaveBeenCalledWith('passkey:registered');
    });

    it('when main window is minimized, should restore it before focusing', async () => {
      vi.stubGlobal('fetch', vi.fn());
      mocks.mainWindow.isMinimized.mockReturnValue(true);

      await handleDeepLink('pagespace://passkey-registered');

      expect(mocks.mainWindow.restore).toHaveBeenCalled();
      expect(mocks.mainWindow.focus).toHaveBeenCalled();
    });
  });

  describe('given pagespace://auth-exchange (regression)', () => {
    it('should still POST to /api/auth/desktop/exchange and never broadcast passkey:registered', async () => {
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          sessionToken: 'sess_abc',
          csrfToken: 'csrf_abc',
          deviceToken: 'dev_abc',
        }),
      }));
      vi.stubGlobal('fetch', fetchSpy);

      await handleDeepLink('pagespace://auth-exchange?code=code123&provider=google');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(call[0]).toContain('/api/auth/desktop/exchange');
      expect(call[1].method).toBe('POST');

      expect(mocks.webContents.send).not.toHaveBeenCalledWith('passkey:registered');
    });
  });

  describe('given an unknown pagespace:// URL', () => {
    it('should fall through to the generic deep-link IPC channel and not crash', async () => {
      vi.stubGlobal('fetch', vi.fn());

      await handleDeepLink('pagespace://foo-bar');

      expect(mocks.webContents.send).toHaveBeenCalledWith('deep-link', 'pagespace://foo-bar');
      expect(mocks.webContents.send).not.toHaveBeenCalledWith('passkey:registered');
    });
  });
});
