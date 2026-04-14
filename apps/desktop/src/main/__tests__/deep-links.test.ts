import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type DidFinishLoadCb = () => void;

const mocks = vi.hoisted(() => {
  const webContents = {
    send: vi.fn(),
    isLoading: vi.fn(() => false),
    once: vi.fn(),
  };
  const mainWindow = {
    webContents,
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn(),
  };
  const state: { current: typeof mainWindow | null } = { current: mainWindow };
  const createWindow = vi.fn(() => {
    state.current = mainWindow;
  });
  return { webContents, mainWindow, state, createWindow };
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
  get mainWindow() {
    return mocks.state.current;
  },
  setCachedSession: vi.fn(),
}));

vi.mock('../window', () => ({
  createWindow: mocks.createWindow,
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
    mocks.webContents.isLoading.mockReset().mockReturnValue(false);
    mocks.webContents.once.mockReset();
    mocks.mainWindow.focus.mockReset();
    mocks.mainWindow.show.mockReset();
    mocks.mainWindow.restore.mockReset();
    mocks.mainWindow.isMinimized.mockReset().mockReturnValue(false);
    mocks.mainWindow.loadURL.mockReset();
    mocks.createWindow.mockReset().mockImplementation(() => {
      mocks.state.current = mocks.mainWindow;
    });
    mocks.state.current = mocks.mainWindow;
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

    it('when no main window exists (macOS all-windows-closed), should create one and defer the IPC until did-finish-load', async () => {
      vi.stubGlobal('fetch', vi.fn());
      mocks.state.current = null;
      mocks.webContents.isLoading.mockReturnValue(true);

      await handleDeepLink('pagespace://passkey-registered');

      expect(mocks.createWindow).toHaveBeenCalledTimes(1);
      expect(mocks.webContents.send).not.toHaveBeenCalledWith('passkey:registered');
      expect(mocks.webContents.once).toHaveBeenCalledWith(
        'did-finish-load',
        expect.any(Function),
      );

      const onceCall = mocks.webContents.once.mock.calls[0];
      const deferred = onceCall[1] as DidFinishLoadCb;
      deferred();

      expect(mocks.webContents.send).toHaveBeenCalledWith('passkey:registered');
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
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/desktop/exchange'),
        expect.objectContaining({ method: 'POST' }),
      );

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
