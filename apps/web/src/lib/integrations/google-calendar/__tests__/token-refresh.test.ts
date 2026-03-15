/**
 * Tests for token-refresh.ts
 * Pure functions: isTokenExpired, buildRefreshParams
 * IO functions: getValidAccessToken, refreshAccessToken, updateConnectionStatus, getConnectionStatus
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

const mockFindFirst = vi.hoisted(() => vi.fn());
const mockUpdateSet = vi.hoisted(() => vi.fn());
const mockUpdateWhere = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      googleCalendarConnections: { findFirst: mockFindFirst },
    },
    update: vi.fn(() => ({ set: mockUpdateSet })),
  },
  googleCalendarConnections: {
    userId: 'userId',
    status: 'status',
    statusMessage: 'statusMessage',
    accessToken: 'accessToken',
    tokenExpiresAt: 'tokenExpiresAt',
    updatedAt: 'updatedAt',
  },
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
}));

const mockEncrypt = vi.hoisted(() => vi.fn());
const mockDecrypt = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/lib', () => ({
  encrypt: mockEncrypt,
  decrypt: mockDecrypt,
}));

const mockAuthLogger = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: mockAuthLogger,
  },
}));

const mockRefreshAccessToken = vi.hoisted(() => vi.fn());
const mockSetCredentials = vi.hoisted(() => vi.fn());

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    setCredentials: mockSetCredentials,
    refreshAccessToken: mockRefreshAccessToken,
  })),
}));

import { isTokenExpired, buildRefreshParams, getValidAccessToken, refreshAccessToken, updateConnectionStatus, getConnectionStatus } from '../token-refresh';
import { db } from '@pagespace/db';

// ---------------------------------------------------------------------------
// isTokenExpired
// ---------------------------------------------------------------------------

describe('isTokenExpired', () => {
  it('should return true when token expires in the past', () => {
    const pastDate = new Date(Date.now() - 10000);
    expect(isTokenExpired(pastDate)).toBe(true);
  });

  it('should return true when token expires within the default buffer (5 minutes)', () => {
    const soonDate = new Date(Date.now() + 2 * 60 * 1000); // 2 min from now
    expect(isTokenExpired(soonDate)).toBe(true);
  });

  it('should return false when token expires well beyond the buffer', () => {
    const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
    expect(isTokenExpired(futureDate)).toBe(false);
  });

  it('should respect a custom buffer value', () => {
    const tenSecondsFromNow = new Date(Date.now() + 10000);
    // With 0 buffer, a 10-second future token is not expired
    expect(isTokenExpired(tenSecondsFromNow, 0)).toBe(false);
    // With 20-second buffer, a 10-second future token IS expired
    expect(isTokenExpired(tenSecondsFromNow, 20000)).toBe(true);
  });

  it('should return true when expiry equals now minus buffer', () => {
    const expiresAt = new Date(Date.now()); // expires now
    expect(isTokenExpired(expiresAt, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRefreshParams
// ---------------------------------------------------------------------------

describe('buildRefreshParams', () => {
  it('should build a URLSearchParams with all required fields', () => {
    const params = buildRefreshParams('refresh-token', 'client-id', 'client-secret');
    expect(params.get('client_id')).toBe('client-id');
    expect(params.get('client_secret')).toBe('client-secret');
    expect(params.get('refresh_token')).toBe('refresh-token');
    expect(params.get('grant_type')).toBe('refresh_token');
  });

  it('should return a URLSearchParams instance', () => {
    const params = buildRefreshParams('rt', 'ci', 'cs');
    expect(params).toBeInstanceOf(URLSearchParams);
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

describe('refreshAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
  });

  it('should return null when GOOGLE_OAUTH_CLIENT_ID is missing', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    const result = await refreshAccessToken('some-refresh-token');
    expect(result).toBeNull();
    expect(mockAuthLogger.error).toHaveBeenCalled();
  });

  it('should return null when GOOGLE_OAUTH_CLIENT_SECRET is missing', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const result = await refreshAccessToken('some-refresh-token');
    expect(result).toBeNull();
    expect(mockAuthLogger.error).toHaveBeenCalled();
  });

  it('should return null when refreshAccessToken returns no access_token', async () => {
    mockRefreshAccessToken.mockResolvedValue({ credentials: {} });
    const result = await refreshAccessToken('refresh-token');
    expect(result).toBeNull();
  });

  it('should return access token and expiry on success', async () => {
    const expiry = Date.now() + 3600 * 1000;
    mockRefreshAccessToken.mockResolvedValue({
      credentials: { access_token: 'new-access-token', expiry_date: expiry },
    });

    const result = await refreshAccessToken('refresh-token');
    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe('new-access-token');
    expect(result?.expiresAt).toBeInstanceOf(Date);
  });

  it('should use default 1-hour expiry when expiry_date is not provided', async () => {
    mockRefreshAccessToken.mockResolvedValue({
      credentials: { access_token: 'new-access-token' },
    });
    const before = Date.now();
    const result = await refreshAccessToken('refresh-token');
    const after = Date.now();
    expect(result).not.toBeNull();
    const expiresAtMs = result!.expiresAt.getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000 - 100);
    expect(expiresAtMs).toBeLessThanOrEqual(after + 3600 * 1000 + 100);
  });

  it('should return null and log error when OAuth client throws', async () => {
    mockRefreshAccessToken.mockRejectedValue(new Error('network failure'));
    const result = await refreshAccessToken('refresh-token');
    expect(result).toBeNull();
    expect(mockAuthLogger.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getValidAccessToken
// ---------------------------------------------------------------------------

describe('getValidAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
  });

  it('should return error when no connection found', async () => {
    mockFindFirst.mockResolvedValue(null);
    const result = await getValidAccessToken('user-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresReauth).toBe(true);
    }
  });

  it('should return error when connection status is not active', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'expired',
      statusMessage: 'Token expired',
      accessToken: 'encrypted-token',
      refreshToken: 'encrypted-refresh',
      tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
    });
    const result = await getValidAccessToken('user-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresReauth).toBe(true);
    }
  });

  it('should return valid token when not expired', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'active',
      accessToken: 'encrypted-access',
      refreshToken: 'encrypted-refresh',
      tokenExpiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour future
    });
    mockDecrypt
      .mockResolvedValueOnce('decrypted-access-token')
      .mockResolvedValueOnce('decrypted-refresh-token');

    const result = await getValidAccessToken('user-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.accessToken).toBe('decrypted-access-token');
    }
  });

  it('should refresh and return new token when expired', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'active',
      accessToken: 'encrypted-access',
      refreshToken: 'encrypted-refresh',
      tokenExpiresAt: new Date(Date.now() - 1000), // expired
    });
    mockDecrypt
      .mockResolvedValueOnce('decrypted-access')
      .mockResolvedValueOnce('decrypted-refresh');
    mockRefreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: 'new-access-token',
        expiry_date: Date.now() + 3600 * 1000,
      },
    });
    mockEncrypt.mockResolvedValue('newly-encrypted-access');

    const result = await getValidAccessToken('user-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.accessToken).toBe('new-access-token');
    }
    expect(db.update).toHaveBeenCalled();
  });

  it('should return error and update status when refresh fails', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'active',
      accessToken: 'encrypted-access',
      refreshToken: 'encrypted-refresh',
      tokenExpiresAt: new Date(Date.now() - 1000), // expired
    });
    mockDecrypt
      .mockResolvedValueOnce('decrypted-access')
      .mockResolvedValueOnce('decrypted-refresh');
    mockRefreshAccessToken.mockResolvedValue({ credentials: {} }); // no access_token → null

    const result = await getValidAccessToken('user-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresReauth).toBe(true);
    }
  });

  it('should return error and update status when decryption fails', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'active',
      accessToken: 'bad-encrypted',
      refreshToken: 'bad-encrypted',
      tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
    });
    mockDecrypt.mockRejectedValue(new Error('decryption error'));

    const result = await getValidAccessToken('user-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresReauth).toBe(true);
    }
  });

  it('should return generic error for unexpected throws', async () => {
    mockFindFirst.mockRejectedValue(new Error('db connection lost'));
    const result = await getValidAccessToken('user-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresReauth).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// updateConnectionStatus
// ---------------------------------------------------------------------------

describe('updateConnectionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  });

  it('should call db.update with the provided status', async () => {
    await updateConnectionStatus('user-1', 'expired', 'Token expired');
    expect(db.update).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired', statusMessage: 'Token expired' })
    );
  });

  it('should accept null statusMessage', async () => {
    await updateConnectionStatus('user-1', 'active', null);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ statusMessage: null })
    );
  });
});

// ---------------------------------------------------------------------------
// getConnectionStatus
// ---------------------------------------------------------------------------

describe('getConnectionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return disconnected state when no connection found', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const result = await getConnectionStatus('user-1');
    expect(result.connected).toBe(false);
    expect(result.status).toBeNull();
    expect(result.googleEmail).toBeNull();
  });

  it('should return connected state when connection is active', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'active',
      googleEmail: 'user@gmail.com',
      lastSyncAt: new Date('2024-03-01'),
      lastSyncError: null,
    });
    const result = await getConnectionStatus('user-1');
    expect(result.connected).toBe(true);
    expect(result.status).toBe('active');
    expect(result.googleEmail).toBe('user@gmail.com');
  });

  it('should return not connected when status is expired', async () => {
    mockFindFirst.mockResolvedValue({
      status: 'expired',
      googleEmail: 'user@gmail.com',
      lastSyncAt: null,
      lastSyncError: 'token expired',
    });
    const result = await getConnectionStatus('user-1');
    expect(result.connected).toBe(false);
    expect(result.status).toBe('expired');
  });
});
