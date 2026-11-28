/**
 * The wallet-change announcements are fire-and-forget bridges: a realtime outage or a
 * vanished wallet must never fail the write that announced it. These tests prove the
 * containment (a database failure is logged, not thrown) and the miss paths (a wallet or
 * drive that is gone announces nothing and logs nothing, so a miss is not mistaken for an
 * outage).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loggers } from '../../logging/logger-config';

process.env.REALTIME_BROADCAST_SECRET = process.env.REALTIME_BROADCAST_SECRET || 'test-realtime-broadcast-secret-32-chars-minimum-length';

const dbState = vi.hoisted(() => ({ failSelect: false }));

vi.mock('@pagespace/db/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/db/db')>();
  const realSelect = actual.db.select.bind(actual.db);
  return {
    db: {
      select: (...args: unknown[]) => {
        if (dbState.failSelect) throw new Error('db down');
        return realSelect(...args as []);
      },
    },
    pool: actual.pool,
  };
});

import { announceDriveWalletChange, announceSpendPreferenceChange, announceWalletChange } from '../wallet-change-events';

const previousRealtimeUrl = process.env.INTERNAL_REALTIME_URL;

beforeEach(() => {
  dbState.failSelect = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousRealtimeUrl === undefined) delete process.env.INTERNAL_REALTIME_URL;
  else process.env.INTERNAL_REALTIME_URL = previousRealtimeUrl;
});

describe('the wallet-change announcements contain their own failures', () => {
  it('a wallet id that does not resolve announces nothing, logs nothing, and resolves', async () => {
    process.env.INTERNAL_REALTIME_URL = 'http://127.0.0.1:1';
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(loggers.realtime, 'warn');
    await expect(announceWalletChange('wallet-gone', 'balance')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a drive whose wallet row is gone announces nothing, logs nothing, and resolves', async () => {
    process.env.INTERNAL_REALTIME_URL = 'http://127.0.0.1:1';
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(loggers.realtime, 'warn');
    await expect(announceDriveWalletChange('drive-gone', 'balance')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a database failure is logged, never thrown — the write that announced already committed', async () => {
    dbState.failSelect = true;
    const warn = vi.spyOn(loggers.realtime, 'warn');
    await expect(announceWalletChange('wallet-1', 'balance')).resolves.toBeUndefined();
    await expect(announceDriveWalletChange('drive-1', 'balance')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a spend-preference change announces even when no realtime server is configured (the emit is a no-op)', async () => {
    delete process.env.INTERNAL_REALTIME_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(announceSpendPreferenceChange('user-1')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a spend-preference change whose realtime broadcast fails resolves and logs once through the emit', async () => {
    process.env.INTERNAL_REALTIME_URL = 'http://127.0.0.1:1';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    const warn = vi.spyOn(loggers.realtime, 'warn');
    await expect(announceSpendPreferenceChange('user-1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('spend:preferences broadcast failed', expect.objectContaining({ userId: 'user-1' }));
  });
});
