import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  session: { defaultSession: { cookies: { set: vi.fn() } } },
}));
vi.mock('../app-url', () => ({ getAppOrigin: vi.fn(() => 'https://pagespace.ai') }));
vi.mock('../logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../auth-storage', () => ({ loadAuthSession: vi.fn() }));
vi.mock('node-machine-id', () => ({ default: { machineIdSync: vi.fn(() => 'machine') } }));

import { session } from 'electron';
import { loadAuthSession } from '../auth-storage';
import { setCachedSession } from '../state';
import {
  buildSessionCookie,
  setSessionCookie,
  restoreSessionCookie,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} from '../session-cookie';

const NOW_MS = 1_800_000_000_000;
const DAY_SECONDS = 24 * 60 * 60;

describe('buildSessionCookie', () => {
  it('given an https origin, should build the secure, http-only session cookie', () => {
    expect(buildSessionCookie('https://pagespace.ai', 'ps_sess_a', NOW_MS)).toEqual({
      url: 'https://pagespace.ai',
      name: 'session',
      value: 'ps_sess_a',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      expirationDate: NOW_MS / 1000 + SESSION_COOKIE_MAX_AGE_SECONDS,
    });
  });

  it('given a plain-http origin, should build a non-secure cookie', () => {
    expect(buildSessionCookie('http://localhost:3000', 't', NOW_MS).secure).toBe(false);
  });

  it('should outlive a 90-day desktop session, not expire after 7 days', () => {
    const { expirationDate } = buildSessionCookie('https://pagespace.ai', 't', NOW_MS);
    expect(expirationDate! - NOW_MS / 1000).toBe(90 * DAY_SECONDS);
  });
});

describe('setSessionCookie', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should write the cookie for the app origin', async () => {
    vi.mocked(session.defaultSession.cookies.set).mockResolvedValue(undefined);
    await setSessionCookie('ps_sess_b');
    expect(session.defaultSession.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://pagespace.ai', name: 'session', value: 'ps_sess_b' }),
    );
  });

  it('given the cookie jar rejects, should not throw', async () => {
    vi.mocked(session.defaultSession.cookies.set).mockRejectedValue(new Error('jar'));
    await expect(setSessionCookie('x')).resolves.toBeUndefined();
  });
});

describe('restoreSessionCookie', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCachedSession(undefined);
    vi.mocked(session.defaultSession.cookies.set).mockResolvedValue(undefined);
  });

  it('given a stored session, should re-write its cookie at startup', async () => {
    vi.mocked(loadAuthSession).mockResolvedValue({
      sessionToken: 'ps_sess_stored',
      csrfToken: 'c',
      deviceToken: 'd',
    });
    await restoreSessionCookie();
    expect(session.defaultSession.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'ps_sess_stored' }),
    );
  });

  it('given no stored session, should write no cookie', async () => {
    vi.mocked(loadAuthSession).mockResolvedValue(null);
    await restoreSessionCookie();
    expect(session.defaultSession.cookies.set).not.toHaveBeenCalled();
  });
});
