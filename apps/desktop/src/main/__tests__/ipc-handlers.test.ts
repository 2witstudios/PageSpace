import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0') },
  ipcMain: {
    handle: vi.fn(),
  },
  session: {
    defaultSession: {
      cookies: {
        set: vi.fn(),
      },
      clearStorageData: vi.fn(),
    },
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

vi.mock('node:os', () => ({
  default: {
    hostname: vi.fn(() => 'test-host'),
    type: vi.fn(() => 'Darwin'),
    release: vi.fn(() => '25.0'),
  },
  hostname: vi.fn(() => 'test-host'),
  type: vi.fn(() => 'Darwin'),
  release: vi.fn(() => '25.0'),
}));

vi.mock('../store', () => ({ store: {} }));
vi.mock('../app-url', () => ({ getAppUrl: vi.fn(() => 'https://pagespace.ai/dashboard') }));
vi.mock('../state', () => ({
  mainWindow: null,
}));
vi.mock('../window', () => ({ reloadMainWindow: vi.fn() }));
vi.mock('../mcp-manager', () => ({ getMCPManager: vi.fn(() => ({ setOnToolsReady: vi.fn() })) }));
vi.mock('../ws-client', () => ({ getWSClient: vi.fn() }));
vi.mock('../logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../error-utils', () => ({ getErrorMessage: vi.fn((e: unknown) => String(e)) }));
vi.mock('../auth-storage', () => ({
  saveAuthSession: vi.fn(),
  clearAuthSession: vi.fn(),
}));
vi.mock('../auth-session', () => ({
  getMachineIdentifier: vi.fn(() => 'machine-id'),
  getOrLoadSession: vi.fn(),
}));
vi.mock('../power-monitor', () => ({ getPowerState: vi.fn() }));
vi.mock('../mcp-status', () => ({ triggerMCPStatusBroadcast: vi.fn() }));

import { ipcMain, session, shell } from 'electron';
import { saveAuthSession } from '../auth-storage';
import { getAppUrl } from '../app-url';
import { registerIPCHandlers } from '../ipc-handlers';

// Extract handlers from ipcMain.handle mock
function getRegisteredHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const calls = vi.mocked(ipcMain.handle).mock.calls;
  const match = calls.find(([ch]) => ch === channel);
  if (!match) throw new Error(`No handler registered for channel: ${channel}`);
  return match[1] as (...args: unknown[]) => Promise<unknown>;
}

describe('IPC Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Register handlers fresh each test
    registerIPCHandlers();
  });

  describe('auth:store-session', () => {
    it('should save session AND set cookie on defaultSession', async () => {
      vi.mocked(saveAuthSession).mockResolvedValue(undefined);
      vi.mocked(session.defaultSession.cookies.set).mockResolvedValue(undefined);
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:store-session');
      const sessionData = {
        sessionToken: 'ps_sess_test',
        csrfToken: 'csrf_test',
        deviceToken: 'ps_dev_test',
      };

      const result = await handler({}, sessionData);

      expect(saveAuthSession).toHaveBeenCalledWith(sessionData);
      expect(session.defaultSession.cookies.set).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://pagespace.ai',
          name: 'session',
          value: 'ps_sess_test',
          path: '/',
          httpOnly: true,
          sameSite: 'strict',
        })
      );
      expect(result).toEqual({ success: true });
    });

    it('should set secure: true for HTTPS origins', async () => {
      vi.mocked(saveAuthSession).mockResolvedValue(undefined);
      vi.mocked(session.defaultSession.cookies.set).mockResolvedValue(undefined);
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:store-session');
      await handler({}, { sessionToken: 'x', csrfToken: 'y', deviceToken: 'z' });

      expect(session.defaultSession.cookies.set).toHaveBeenCalledWith(
        expect.objectContaining({ secure: true })
      );
    });

    it('should set secure: false for HTTP LAN origins', async () => {
      vi.mocked(saveAuthSession).mockResolvedValue(undefined);
      vi.mocked(session.defaultSession.cookies.set).mockResolvedValue(undefined);
      vi.mocked(getAppUrl).mockReturnValue('http://pagespace.local:3000/dashboard');

      const handler = getRegisteredHandler('auth:store-session');
      await handler({}, { sessionToken: 'x', csrfToken: 'y', deviceToken: 'z' });

      expect(session.defaultSession.cookies.set).toHaveBeenCalledWith(
        expect.objectContaining({ secure: false })
      );
    });

    it('should set secure: false for localhost', async () => {
      vi.mocked(saveAuthSession).mockResolvedValue(undefined);
      vi.mocked(session.defaultSession.cookies.set).mockResolvedValue(undefined);
      vi.mocked(getAppUrl).mockReturnValue('http://localhost:3000/dashboard');

      const handler = getRegisteredHandler('auth:store-session');
      await handler({}, { sessionToken: 'x', csrfToken: 'y', deviceToken: 'z' });

      expect(session.defaultSession.cookies.set).toHaveBeenCalledWith(
        expect.objectContaining({ secure: false })
      );
    });

    it('should still succeed if cookie setting fails (non-blocking)', async () => {
      vi.mocked(saveAuthSession).mockResolvedValue(undefined);
      vi.mocked(session.defaultSession.cookies.set).mockRejectedValue(new Error('Cookie error'));

      const handler = getRegisteredHandler('auth:store-session');
      const result = await handler({}, {
        sessionToken: 'ps_sess_x',
        csrfToken: 'csrf_x',
        deviceToken: 'ps_dev_x',
      });

      expect(result).toEqual({ success: true });
    });
  });

  describe('auth:open-external', () => {
    it('should open allowed Google OAuth URL', async () => {
      vi.mocked(shell.openExternal).mockResolvedValue(undefined);

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=xxx'
      );

      expect(shell.openExternal).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=xxx'
      );
      expect(result).toEqual({ success: true });
    });

    it('should open allowed Apple OAuth URL', async () => {
      vi.mocked(shell.openExternal).mockResolvedValue(undefined);

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'https://appleid.apple.com/auth/authorize?client_id=xxx'
      );

      expect(shell.openExternal).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('should reject URLs with non-allowlisted hostnames', async () => {
      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler({}, 'https://evil.com/phish');

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: expect.stringContaining('not allowed') });
    });

    it('should reject URLs that look like google but arent', async () => {
      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'https://fake-accounts.google.com/o/oauth2'
      );

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: expect.stringContaining('not allowed') });
    });

    it('should reject non-HTTPS URLs', async () => {
      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'http://accounts.google.com/o/oauth2'
      );

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: expect.stringContaining('not allowed') });
    });

    it('should reject invalid URLs', async () => {
      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler({}, 'not-a-url');

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: expect.stringContaining('Invalid') });
    });

    it('allows /auth/passkey-external on the configured app origin', async () => {
      vi.mocked(shell.openExternal).mockResolvedValue(undefined);
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'https://pagespace.ai/auth/passkey-external?deviceId=d&deviceName=Mac',
      );

      expect(shell.openExternal).toHaveBeenCalledWith(
        'https://pagespace.ai/auth/passkey-external?deviceId=d&deviceName=Mac',
      );
      expect(result).toEqual({ success: true });
    });

    it('allows a localhost http app origin in development', async () => {
      vi.mocked(shell.openExternal).mockResolvedValue(undefined);
      vi.mocked(getAppUrl).mockReturnValue('http://localhost:3000/dashboard');

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'http://localhost:3000/auth/passkey-external?deviceId=d&deviceName=Mac',
      );

      expect(shell.openExternal).toHaveBeenCalledWith(
        'http://localhost:3000/auth/passkey-external?deviceId=d&deviceName=Mac',
      );
      expect(result).toEqual({ success: true });
    });

    it('rejects app-origin URLs whose path is not /auth/passkey-external', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'https://pagespace.ai/dashboard/drive/123',
      );

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not allowed'),
      });
    });

    it('rejects app-origin lookalike hosts', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'https://pagespace.ai.evil.com/auth/passkey-external',
      );

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not allowed'),
      });
    });

    it('rejects http on non-localhost even for /auth/passkey-external', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'http://pagespace.ai/auth/passkey-external',
      );

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not allowed'),
      });
    });
  });
});
