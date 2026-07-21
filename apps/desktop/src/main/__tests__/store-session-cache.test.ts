import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unlike ipc-handlers.test.ts (which mocks ../state and ../auth-session away),
// this suite runs the REAL main-process session cache: real ./state module
// state, real getOrLoadSession, real IPC handlers. The bug under test is the
// interplay between them — auth:store-session persisted a refreshed token to
// disk + cookie jar but never updated the in-memory cachedSession, so every
// subsequent getOrLoadSession()/auth:get-session-token kept serving the STALE
// startup token until sleep/wake or app restart (the desktop "random logout").

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0'),
    getPath: vi.fn(() => '/tmp/userData'),
  },
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

vi.mock('node-machine-id', () => ({
  default: { machineIdSync: vi.fn(() => 'machine-id') },
}));

vi.mock('../store', () => ({ store: { set: vi.fn() } }));
vi.mock('../app-url', () => ({ getAppUrl: vi.fn(() => 'https://pagespace.ai/dashboard') }));
vi.mock('../window', () => ({ reloadMainWindow: vi.fn() }));
vi.mock('../mcp-manager', () => ({ getMCPManager: vi.fn(() => ({ setOnToolsReady: vi.fn() })) }));
vi.mock('../ws-client', () => ({ getWSClient: vi.fn() }));
vi.mock('../logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../error-utils', () => ({
  getErrorMessage: vi.fn((e: unknown) => String(e)),
  hasErrorCode: vi.fn(() => false),
}));
vi.mock('../auth-storage', () => ({
  saveAuthSession: vi.fn(),
  clearAuthSession: vi.fn(),
  loadAuthSession: vi.fn(),
}));
vi.mock('../power-monitor', () => ({ getPowerState: vi.fn() }));
vi.mock('../mcp-status', () => ({ triggerMCPStatusBroadcast: vi.fn() }));

import { ipcMain } from 'electron';
import { saveAuthSession, loadAuthSession, type StoredAuthSession } from '../auth-storage';
import { setCachedSession } from '../state';
import { getOrLoadSession } from '../auth-session';
import { registerIPCHandlers } from '../ipc-handlers';

const trustedEvent = { senderFrame: { url: 'https://pagespace.ai/dashboard' } };
const untrustedEvent = { senderFrame: { url: 'https://evil.com/x' } };

function getRegisteredHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const calls = vi.mocked(ipcMain.handle).mock.calls;
  const match = calls.find(([ch]) => ch === channel);
  if (!match) throw new Error(`No handler registered for channel: ${channel}`);
  return match[1] as (...args: unknown[]) => Promise<unknown>;
}

const OLD_SESSION: StoredAuthSession = {
  sessionToken: 'ps_sess_OLD_startup_token',
  csrfToken: 'csrf_old',
  deviceToken: 'ps_dev_old',
};

const NEW_SESSION: StoredAuthSession = {
  sessionToken: 'ps_sess_NEW_refreshed_token',
  csrfToken: 'csrf_new',
  deviceToken: 'ps_dev_new',
};

describe('main-process session cache stays fresh across auth:store-session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the real module-level cache to its process-startup state.
    setCachedSession(undefined);
    registerIPCHandlers();
    vi.mocked(saveAuthSession).mockResolvedValue(undefined);
    vi.mocked(loadAuthSession).mockResolvedValue(OLD_SESSION);
  });

  it('getOrLoadSession() returns the NEW token immediately after auth:store-session (not the cached startup token)', async () => {
    // Startup: cache primes itself from disk with the OLD token.
    expect((await getOrLoadSession())?.sessionToken).toBe(OLD_SESSION.sessionToken);

    // The renderer refreshes and stores the NEW session via IPC.
    const storeHandler = getRegisteredHandler('auth:store-session');
    await storeHandler(trustedEvent, NEW_SESSION);

    // The cache must serve the refreshed token — no restart/sleep-wake needed.
    expect((await getOrLoadSession())?.sessionToken).toBe(NEW_SESSION.sessionToken);
  });

  it('auth:get-session-token reflects the new token immediately after a store', async () => {
    await getOrLoadSession(); // prime cache with OLD

    const storeHandler = getRegisteredHandler('auth:store-session');
    await storeHandler(trustedEvent, NEW_SESSION);

    const tokenHandler = getRegisteredHandler('auth:get-session-token');
    expect(await tokenHandler(trustedEvent)).toBe(NEW_SESSION.sessionToken);
  });

  it('auth:get-session reflects the full new session immediately after a store', async () => {
    await getOrLoadSession(); // prime cache with OLD

    const storeHandler = getRegisteredHandler('auth:store-session');
    await storeHandler(trustedEvent, NEW_SESSION);

    const sessionHandler = getRegisteredHandler('auth:get-session');
    expect(await sessionHandler(trustedEvent)).toEqual(NEW_SESSION);
  });

  it('regression: startup behavior unchanged — first read loads from disk, later reads hit the cache', async () => {
    const first = await getOrLoadSession();
    const second = await getOrLoadSession();

    expect(first?.sessionToken).toBe(OLD_SESSION.sessionToken);
    expect(second?.sessionToken).toBe(OLD_SESSION.sessionToken);
    // Only the first call touches disk; the cache answers afterwards.
    expect(loadAuthSession).toHaveBeenCalledTimes(1);
  });

  it('regression: a resume-style cache reset (setCachedSession(undefined)) still re-reads from disk', async () => {
    await getOrLoadSession();
    setCachedSession(undefined); // what the power-monitor resume path does

    vi.mocked(loadAuthSession).mockResolvedValue(NEW_SESSION);
    expect((await getOrLoadSession())?.sessionToken).toBe(NEW_SESSION.sessionToken);
    expect(loadAuthSession).toHaveBeenCalledTimes(2);
  });

  it('security regression: an untrusted sender cannot poison the cache via auth:store-session', async () => {
    await getOrLoadSession(); // prime cache with OLD

    const storeHandler = getRegisteredHandler('auth:store-session');
    const result = await storeHandler(untrustedEvent, {
      sessionToken: 'ps_sess_ATTACKER',
      csrfToken: 'x',
      deviceToken: 'y',
    });

    expect(result).toEqual({ success: false });
    expect((await getOrLoadSession())?.sessionToken).toBe(OLD_SESSION.sessionToken);
  });

  it('does not cache a session whose persistence failed (cache only updates after a successful save)', async () => {
    await getOrLoadSession(); // prime cache with OLD
    vi.mocked(saveAuthSession).mockRejectedValue(new Error('disk full'));

    const storeHandler = getRegisteredHandler('auth:store-session');
    await expect(storeHandler(trustedEvent, NEW_SESSION)).rejects.toThrow('disk full');

    expect((await getOrLoadSession())?.sessionToken).toBe(OLD_SESSION.sessionToken);
  });

  it('auth:clear-auth invalidates the in-memory cache so a known-bad token cannot persist', async () => {
    await getOrLoadSession(); // prime cache with OLD

    const clearHandler = getRegisteredHandler('auth:clear-auth');
    await clearHandler(trustedEvent);

    // After a clear, the session file is gone — the cache must not keep
    // serving the retired token.
    vi.mocked(loadAuthSession).mockResolvedValue(null);
    expect(await getOrLoadSession()).toBeNull();
  });
});
