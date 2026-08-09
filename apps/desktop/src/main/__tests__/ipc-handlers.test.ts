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

vi.mock('../store', () => ({ store: { set: vi.fn() } }));
vi.mock('../app-url', () => ({ getAppUrl: vi.fn(() => 'https://pagespace.ai/dashboard') }));
vi.mock('../state', () => ({
  mainWindow: null,
  setCachedSession: vi.fn(),
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
import { store } from '../store';
import { getOrLoadSession } from '../auth-session';
import { registerIPCHandlers } from '../ipc-handlers';

// The handler persists via an `as any` cast on the store; the real type does
// not expose `set`, so reach the mock through a narrow cast in the test.
const mockedStoreSet = (store as unknown as { set: ReturnType<typeof vi.fn> }).set;

// A sender frame on the trusted app origin.
const trustedEvent = { senderFrame: { url: 'https://pagespace.ai/dashboard' } };
// A sender frame on a foreign origin (e.g. after an off-origin navigation).
const untrustedEvent = { senderFrame: { url: 'https://evil.com/x' } };
// No sender frame at all (fails closed).
const noFrameEvent = {};
// Build a sender event whose origin matches a given configured app URL.
const senderFor = (appUrl: string) => ({ senderFrame: { url: appUrl } });

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

      const result = await handler(senderFor('https://pagespace.ai/dashboard'), sessionData);

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
      await handler(senderFor('https://pagespace.ai/dashboard'), { sessionToken: 'x', csrfToken: 'y', deviceToken: 'z' });

      expect(session.defaultSession.cookies.set).toHaveBeenCalledWith(
        expect.objectContaining({ secure: true })
      );
    });

    it('should set secure: false for HTTP LAN origins', async () => {
      vi.mocked(saveAuthSession).mockResolvedValue(undefined);
      vi.mocked(session.defaultSession.cookies.set).mockResolvedValue(undefined);
      vi.mocked(getAppUrl).mockReturnValue('http://pagespace.local:3000/dashboard');

      const handler = getRegisteredHandler('auth:store-session');
      await handler(senderFor('http://pagespace.local:3000/dashboard'), { sessionToken: 'x', csrfToken: 'y', deviceToken: 'z' });

      expect(session.defaultSession.cookies.set).toHaveBeenCalledWith(
        expect.objectContaining({ secure: false })
      );
    });

    it('should set secure: false for localhost', async () => {
      vi.mocked(saveAuthSession).mockResolvedValue(undefined);
      vi.mocked(session.defaultSession.cookies.set).mockResolvedValue(undefined);
      vi.mocked(getAppUrl).mockReturnValue('http://localhost:3000/dashboard');

      const handler = getRegisteredHandler('auth:store-session');
      await handler(senderFor('http://localhost:3000/dashboard'), { sessionToken: 'x', csrfToken: 'y', deviceToken: 'z' });

      expect(session.defaultSession.cookies.set).toHaveBeenCalledWith(
        expect.objectContaining({ secure: false })
      );
    });

    it('should still succeed if cookie setting fails (non-blocking)', async () => {
      vi.mocked(saveAuthSession).mockResolvedValue(undefined);
      vi.mocked(session.defaultSession.cookies.set).mockRejectedValue(new Error('Cookie error'));
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:store-session');
      const result = await handler(senderFor('https://pagespace.ai/dashboard'), {
        sessionToken: 'ps_sess_x',
        csrfToken: 'csrf_x',
        deviceToken: 'ps_dev_x',
      });

      expect(result).toEqual({ success: true });
    });

    it('refuses to store a session from an untrusted sender (no injection)', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:store-session');
      const result = await handler(untrustedEvent, {
        sessionToken: 'attacker',
        csrfToken: 'x',
        deviceToken: 'y',
      });

      expect(result).toEqual({ success: false });
      expect(saveAuthSession).not.toHaveBeenCalled();
      expect(session.defaultSession.cookies.set).not.toHaveBeenCalled();
    });
  });

  describe('set-app-url (H5 allowlist + origin gate)', () => {
    it('stores an allowlisted app URL from a trusted sender', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');
      const handler = getRegisteredHandler('set-app-url');

      const result = await handler(trustedEvent, 'https://pagespace.ai/dashboard');

      expect(result).toBe(true);
      expect(mockedStoreSet).toHaveBeenCalledWith('appUrl', 'https://pagespace.ai/dashboard');
    });

    it('rejects a non-allowlisted URL without storing it', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');
      const handler = getRegisteredHandler('set-app-url');

      const result = await handler(trustedEvent, 'https://evil.com/phish');

      expect(result).toBe(false);
      expect(mockedStoreSet).not.toHaveBeenCalled();
    });

    it('rejects any set-app-url from an untrusted sender', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');
      const handler = getRegisteredHandler('set-app-url');

      const result = await handler(untrustedEvent, 'https://pagespace.ai/dashboard');

      expect(result).toBe(false);
      expect(mockedStoreSet).not.toHaveBeenCalled();
    });

    it('allows the currently-configured (env) origin even if not static', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://app.example.com/dashboard');
      const handler = getRegisteredHandler('set-app-url');

      const result = await handler(
        { senderFrame: { url: 'https://app.example.com/dashboard' } },
        'https://app.example.com/dashboard',
      );

      expect(result).toBe(true);
      expect(mockedStoreSet).toHaveBeenCalledWith('appUrl', 'https://app.example.com/dashboard');
    });
  });

  describe('auth:get-session-token (H5 origin gate)', () => {
    it('returns the token to a trusted sender', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');
      vi.mocked(getOrLoadSession).mockResolvedValue({ sessionToken: 'ps_sess_secret' } as never);
      const handler = getRegisteredHandler('auth:get-session-token');

      const result = await handler(trustedEvent);

      expect(result).toBe('ps_sess_secret');
    });

    it('returns null to an untrusted sender (token never leaves)', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');
      vi.mocked(getOrLoadSession).mockResolvedValue({ sessionToken: 'ps_sess_secret' } as never);
      const handler = getRegisteredHandler('auth:get-session-token');

      const result = await handler(untrustedEvent);

      expect(result).toBeNull();
      expect(vi.mocked(getOrLoadSession)).not.toHaveBeenCalled();
    });

    it('fails closed when the sender frame is unknown', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');
      const handler = getRegisteredHandler('auth:get-session-token');

      const result = await handler(noFrameEvent);

      expect(result).toBeNull();
    });
  });

  describe('auth:begin-exchange (L9)', () => {
    it('returns a fresh opaque state to a trusted sender', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');
      const handler = getRegisteredHandler('auth:begin-exchange');

      const result = await handler(trustedEvent);

      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('refuses an untrusted sender', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');
      const handler = getRegisteredHandler('auth:begin-exchange');

      const result = await handler(untrustedEvent);

      expect(result).toBeNull();
    });
  });

  describe('mcp:execute-tool (H5 origin gate)', () => {
    it('refuses execution from an untrusted sender', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');
      const handler = getRegisteredHandler('mcp:execute-tool');

      const result = await handler(untrustedEvent, 'srv', 'tool', {});

      expect(result).toEqual({ success: false, error: 'Untrusted sender origin' });
    });
  });

  describe('mcp:get-config (H5 origin gate — env secrets)', () => {
    it('returns an empty config to an untrusted sender (no env leak)', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');
      const handler = getRegisteredHandler('mcp:get-config');

      const result = await handler(untrustedEvent);

      expect(result).toEqual({ mcpServers: {} });
    });
  });

  describe('mcp:stop-server (H5 origin gate)', () => {
    it('refuses to stop a server from an untrusted sender', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');
      const handler = getRegisteredHandler('mcp:stop-server');

      const result = await handler(untrustedEvent, 'srv');

      expect(result).toEqual({ success: false, error: 'Untrusted sender origin' });
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

    it('allows /auth/passkey-register-external on the configured app origin', async () => {
      vi.mocked(shell.openExternal).mockResolvedValue(undefined);
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'https://pagespace.ai/auth/passkey-register-external?deviceId=d&deviceName=Mac',
      );

      expect(shell.openExternal).toHaveBeenCalledWith(
        'https://pagespace.ai/auth/passkey-register-external?deviceId=d&deviceName=Mac',
      );
      expect(result).toEqual({ success: true });
    });

    it('allows /auth/passkey-register-external on a localhost http app origin', async () => {
      vi.mocked(shell.openExternal).mockResolvedValue(undefined);
      vi.mocked(getAppUrl).mockReturnValue('http://localhost:3000/dashboard');

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'http://localhost:3000/auth/passkey-register-external?deviceId=d&deviceName=Mac',
      );

      expect(shell.openExternal).toHaveBeenCalledWith(
        'http://localhost:3000/auth/passkey-register-external?deviceId=d&deviceName=Mac',
      );
      expect(result).toEqual({ success: true });
    });

    it('rejects /auth/passkey-register-external on a third-party origin', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'https://evil.com/auth/passkey-register-external?deviceId=d',
      );

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not allowed'),
      });
    });

    it('rejects app-origin lookalike hosts for /auth/passkey-register-external', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'https://pagespace.ai.evil.com/auth/passkey-register-external',
      );

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not allowed'),
      });
    });

    it('rejects http on non-localhost even for /auth/passkey-register-external', async () => {
      vi.mocked(getAppUrl).mockReturnValue('https://pagespace.ai/dashboard');

      const handler = getRegisteredHandler('auth:open-external');
      const result = await handler(
        {},
        'http://pagespace.ai/auth/passkey-register-external',
      );

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('not allowed'),
      });
    });
  });
});
