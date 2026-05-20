// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ field: a, value: b })),
}));

vi.mock('@pagespace/db/schema/zoom', () => ({
  zoomConnections: { userId: 'userId' },
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      zoomConnections: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
  },
}));

vi.mock('@pagespace/lib/encryption/encryption-utils', () => ({
  encrypt: vi.fn(async (v: string) => `enc:${v}`),
  decrypt: vi.fn(async (v: string) => v.replace(/^enc:/, '')),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { db } from '@pagespace/db/db';
import { isTokenExpired, getValidZoomAccessToken } from '../token-refresh';

const mockDb = db as unknown as {
  query: { zoomConnections: { findFirst: ReturnType<typeof vi.fn> } };
  update: ReturnType<typeof vi.fn>;
};

describe('isTokenExpired', () => {
  it('returns false when expiresAt is null (unknown expiry)', () => {
    expect(isTokenExpired(null)).toBe(false);
  });

  it('returns true when token is past expiry', () => {
    const past = new Date(Date.now() - 1000);
    expect(isTokenExpired(past)).toBe(true);
  });

  it('returns false when token has plenty of time left', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(isTokenExpired(future)).toBe(false);
  });

  it('returns true when token expires within the buffer window', () => {
    const soonExpiring = new Date(Date.now() + 2 * 60 * 1000); // 2 min from now, within 5-min buffer
    expect(isTokenExpired(soonExpiring)).toBe(true);
  });

  it('returns false when token expires just outside the buffer window', () => {
    const notYet = new Date(Date.now() + 10 * 60 * 1000); // 10 min from now
    expect(isTokenExpired(notYet)).toBe(false);
  });
});

describe('getValidZoomAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ZOOM_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.ZOOM_OAUTH_CLIENT_SECRET = 'test-client-secret';
  });

  it('returns requiresReauth when no connection exists', async () => {
    mockDb.query.zoomConnections.findFirst.mockResolvedValue(null);

    const result = await getValidZoomAccessToken('user-1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.requiresReauth).toBe(true);
  });

  it('returns requiresReauth when connection is not active', async () => {
    mockDb.query.zoomConnections.findFirst.mockResolvedValue({
      accessToken: 'enc:tok',
      refreshToken: 'enc:ref',
      tokenExpiresAt: null,
      status: 'disconnected',
    });

    const result = await getValidZoomAccessToken('user-1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.requiresReauth).toBe(true);
  });

  it('returns stored access token when it is not expired', async () => {
    const futureExpiry = new Date(Date.now() + 30 * 60 * 1000);
    mockDb.query.zoomConnections.findFirst.mockResolvedValue({
      userId: 'user-1',
      accessToken: 'enc:valid-token',
      refreshToken: 'enc:refresh-token',
      tokenExpiresAt: futureExpiry,
      status: 'active',
    });

    const result = await getValidZoomAccessToken('user-1');
    expect(result).toEqual({ success: true, accessToken: 'valid-token' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes token when expired and returns new access token', async () => {
    const pastExpiry = new Date(Date.now() - 1000);
    mockDb.query.zoomConnections.findFirst.mockResolvedValue({
      userId: 'user-1',
      accessToken: 'enc:old-token',
      refreshToken: 'enc:valid-refresh',
      tokenExpiresAt: pastExpiry,
      status: 'active',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'new-token', expires_in: 3600 }),
    });
    const set = vi.fn().mockReturnValue({ where: vi.fn() });
    mockDb.update.mockReturnValue({ set });

    const result = await getValidZoomAccessToken('user-1');
    expect(result).toEqual({ success: true, accessToken: 'new-token' });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'enc:new-token',
      status: 'active',
    }));
  });

  it('returns requiresReauth when expired and no refresh token stored', async () => {
    mockDb.query.zoomConnections.findFirst.mockResolvedValue({
      userId: 'user-1',
      accessToken: 'enc:old-token',
      refreshToken: null,
      tokenExpiresAt: new Date(Date.now() - 1000),
      status: 'active',
    });

    const result = await getValidZoomAccessToken('user-1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.requiresReauth).toBe(true);
  });

  it('returns requiresReauth and marks connection expired when refresh call fails', async () => {
    mockDb.query.zoomConnections.findFirst.mockResolvedValue({
      userId: 'user-1',
      accessToken: 'enc:old-token',
      refreshToken: 'enc:bad-refresh',
      tokenExpiresAt: new Date(Date.now() - 1000),
      status: 'active',
    });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const set = vi.fn().mockReturnValue({ where: vi.fn() });
    mockDb.update.mockReturnValue({ set });

    const result = await getValidZoomAccessToken('user-1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.requiresReauth).toBe(true);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
  });

  it('also handles null tokenExpiresAt (unknown expiry) as not expired', async () => {
    mockDb.query.zoomConnections.findFirst.mockResolvedValue({
      userId: 'user-1',
      accessToken: 'enc:current-token',
      refreshToken: 'enc:refresh',
      tokenExpiresAt: null,
      status: 'active',
    });

    const result = await getValidZoomAccessToken('user-1');
    expect(result).toEqual({ success: true, accessToken: 'current-token' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
