import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock at the service seam level
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      deviceTokens: { findFirst: vi.fn() },
    },
    update: vi.fn(),
  },
  users: { id: 'id', tokenVersion: 'tokenVersion' },
  deviceTokens: {
    userId: 'userId',
    tokenHash: 'tokenHash',
    revokedAt: 'revokedAt',
    expiresAt: 'expiresAt',
  },
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  isNull: vi.fn((a) => ({ isNull: a })),
  gt: vi.fn((a, b) => ({ gt: [a, b] })),
  sql: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn((token: string) => `hashed_${token}`),
  isValidTokenFormat: vi.fn(),
  getTokenType: vi.fn(),
}));

vi.mock('@pagespace/lib/secure-compare', () => ({
  secureCompare: vi.fn(),
}));

vi.mock('@pagespace/lib/device-auth-utils', () => ({
  getUserDeviceTokens: vi.fn(),
  revokeAllUserDeviceTokens: vi.fn(),
  createDeviceTokenRecord: vi.fn(),
  revokeExpiredDeviceTokens: vi.fn(),
}));

import { GET, DELETE } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { hashToken, isValidTokenFormat, getTokenType } from '@pagespace/lib/auth';
import { secureCompare } from '@pagespace/lib/secure-compare';
import {
  getUserDeviceTokens,
  revokeAllUserDeviceTokens,
  createDeviceTokenRecord,
  revokeExpiredDeviceTokens,
} from '@pagespace/lib/device-auth-utils';

// Test helpers
const mockSessionAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createGetRequest = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/account/devices', {
    method: 'GET',
    headers,
  });

const createDeleteRequest = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/account/devices', {
    method: 'DELETE',
    headers,
  });

const mockDeviceToken = (overrides: Record<string, unknown> = {}) => ({
  id: 'device-1',
  platform: 'desktop' as const,
  deviceName: 'My MacBook',
  deviceId: 'dev-abc123',
  lastUsedAt: new Date('2024-06-01'),
  trustScore: 100,
  suspiciousActivityCount: 0,
  ipAddress: '192.168.1.1',
  lastIpAddress: '192.168.1.1',
  location: 'Home',
  userAgent: 'Mozilla/5.0',
  createdAt: new Date('2024-01-01'),
  expiresAt: new Date('2025-01-01'),
  tokenHash: 'hashed_device_token_123',
  ...overrides,
});

const mockUpdateChain = () => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.update = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.update).mockImplementation(chain.update as never);
  return chain;
};

// ============================================================================
// GET /api/account/devices
// ============================================================================

/** @scaffold - ORM chain mocks until repository seam exists */
describe('GET /api/account/devices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('returns auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createGetRequest());

      expect(response.status).toBe(401);
    });

    it('uses session-only auth without CSRF for reads', async () => {
      vi.mocked(getUserDeviceTokens).mockResolvedValue([]);

      const request = createGetRequest();
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('device listing', () => {
    it('returns empty array when no devices', async () => {
      vi.mocked(getUserDeviceTokens).mockResolvedValue([]);

      const response = await GET(createGetRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });

    it('returns formatted device list', async () => {
      vi.mocked(getUserDeviceTokens).mockResolvedValue([mockDeviceToken()] as never);
      vi.mocked(secureCompare).mockReturnValue(false);

      const response = await GET(createGetRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: 'device-1',
        platform: 'desktop',
        deviceName: 'My MacBook',
        deviceId: 'dev-abc123',
        trustScore: 100,
        suspiciousActivityCount: 0,
        isCurrent: false,
      });
      expect(body[0].lastUsedAt).toBe('2024-06-01T00:00:00.000Z');
      expect(body[0].createdAt).toBe('2024-01-01T00:00:00.000Z');
      expect(body[0].expiresAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('uses createdAt as fallback when lastUsedAt is null', async () => {
      vi.mocked(getUserDeviceTokens).mockResolvedValue([
        // @ts-expect-error - partial mock data
        mockDeviceToken({ lastUsedAt: null }),
      ]);
      vi.mocked(secureCompare).mockReturnValue(false);

      const response = await GET(createGetRequest());
      const body = await response.json();

      expect(body[0].lastUsedAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('marks current device with isCurrent=true', async () => {
      vi.mocked(getUserDeviceTokens).mockResolvedValue([
        // @ts-expect-error - partial mock data
        mockDeviceToken({ tokenHash: 'hashed_my-device-token' }),
      ]);
      vi.mocked(secureCompare).mockReturnValue(true);

      const response = await GET(
        createGetRequest({ 'x-device-token': 'my-device-token' })
      );
      const body = await response.json();

      expect(body[0].isCurrent).toBe(true);
      expect(hashToken).toHaveBeenCalledWith('my-device-token');
    });

    it('sets isCurrent=false when no x-device-token header', async () => {
      vi.mocked(getUserDeviceTokens).mockResolvedValue([mockDeviceToken()] as never);

      const response = await GET(createGetRequest());
      const body = await response.json();

      expect(body[0].isCurrent).toBe(false);
    });

    it('sets isCurrent=false when device has no tokenHash', async () => {
      vi.mocked(getUserDeviceTokens).mockResolvedValue([
        // @ts-expect-error - partial mock data
        mockDeviceToken({ tokenHash: null }),
      ]);

      const response = await GET(
        createGetRequest({ 'x-device-token': 'some-token' })
      );
      const body = await response.json();

      expect(body[0].isCurrent).toBe(false);
    });
  });

  describe('error handling', () => {
    it('returns 500 when getUserDeviceTokens throws', async () => {
      vi.mocked(getUserDeviceTokens).mockRejectedValueOnce(new Error('DB error'));

      const response = await GET(createGetRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch devices');
    });
  });
});

// ============================================================================
// DELETE /api/account/devices
// ============================================================================

/** @scaffold - ORM chain mocks until repository seam exists */
describe('DELETE /api/account/devices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('returns auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(createDeleteRequest());

      expect(response.status).toBe(401);
    });

    it('uses session-only auth with CSRF for writes', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        tokenVersion: 0,
      });
      mockUpdateChain();
      vi.mocked(revokeAllUserDeviceTokens).mockResolvedValue(undefined);

      const request = createDeleteRequest();
      await DELETE(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('user not found', () => {
    it('returns 404 when user not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

      const response = await DELETE(createDeleteRequest());
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });
  });

  describe('revoke without current device token', () => {
    it('revokes all device tokens and bumps tokenVersion', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        tokenVersion: 3,
      });
      mockUpdateChain();
      vi.mocked(revokeAllUserDeviceTokens).mockResolvedValue(undefined);

      const response = await DELETE(createDeleteRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('All other devices have been logged out');
      expect(body.deviceToken).toBeUndefined();
      expect(revokeAllUserDeviceTokens).toHaveBeenCalledWith('user-1', 'user_action');
    });
  });

  describe('revoke with current device token (valid format)', () => {
    beforeEach(() => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        tokenVersion: 3,
      });
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(getTokenType).mockReturnValue('dev');
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue({
        deviceId: 'dev-abc',
        platform: 'desktop',
        deviceName: 'My MacBook',
      });
      vi.mocked(createDeviceTokenRecord).mockResolvedValue({
        token: 'new_device_token_xyz',
        id: 'new-token-id',
        // @ts-expect-error - test mock with extra properties
        tokenHash: 'hashed_new_device_token_xyz',
      });
      vi.mocked(revokeExpiredDeviceTokens).mockResolvedValue(undefined as never);
      mockUpdateChain();
    });

    it('creates new device token and returns it', async () => {
      const response = await DELETE(
        createDeleteRequest({ 'x-device-token': 'ps_dev_current_token' })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('All other devices have been logged out');
      expect(body.deviceToken).toBe('new_device_token_xyz');
    });

    it('revokes old device token before creating new one', async () => {
      const chain = mockUpdateChain();

      await DELETE(
        createDeleteRequest({ 'x-device-token': 'ps_dev_current_token' })
      );

      // Should revoke old token
      expect(chain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          revokedAt: expect.any(Date),
          revokedReason: 'user_action',
        })
      );
    });

    it('creates new token with incremented tokenVersion', async () => {
      await DELETE(
        createDeleteRequest({ 'x-device-token': 'ps_dev_current_token' })
      );

      expect(createDeviceTokenRecord).toHaveBeenCalledWith(
        'user-1',
        'dev-abc',
        'desktop',
        4, // tokenVersion 3 + 1
        expect.objectContaining({
          deviceName: 'My MacBook',
        })
      );
    });

    it('calls revokeExpiredDeviceTokens before creating new token', async () => {
      await DELETE(
        createDeleteRequest({ 'x-device-token': 'ps_dev_current_token' })
      );

      expect(revokeExpiredDeviceTokens).toHaveBeenCalledWith(
        'user-1',
        'dev-abc',
        'desktop'
      );
    });

    it('passes user-agent and IP from request headers', async () => {
      await DELETE(
        createDeleteRequest({
          'x-device-token': 'ps_dev_current_token',
          'user-agent': 'TestAgent/1.0',
          'x-forwarded-for': '10.0.0.1,10.0.0.2',
        })
      );

      expect(createDeviceTokenRecord).toHaveBeenCalledWith(
        'user-1',
        'dev-abc',
        'desktop',
        4,
        expect.objectContaining({
          userAgent: 'TestAgent/1.0',
          ipAddress: '10.0.0.1',
        })
      );
    });

    it('uses x-real-ip when x-forwarded-for is missing', async () => {
      await DELETE(
        createDeleteRequest({
          'x-device-token': 'ps_dev_current_token',
          'x-real-ip': '172.16.0.1',
        })
      );

      expect(createDeviceTokenRecord).toHaveBeenCalledWith(
        'user-1',
        'dev-abc',
        'desktop',
        4,
        expect.objectContaining({
          ipAddress: '172.16.0.1',
        })
      );
    });
  });

  describe('revoke with invalid token format', () => {
    it('does not look up device record for invalid token format', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        tokenVersion: 3,
      });
      vi.mocked(isValidTokenFormat).mockReturnValue(false);
      mockUpdateChain();

      await DELETE(
        createDeleteRequest({ 'x-device-token': 'invalid_token' })
      );

      expect(db.query.deviceTokens.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('revoke with valid format but wrong token type', () => {
    it('does not look up device record for non-dev token type', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        tokenVersion: 3,
      });
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(getTokenType).mockReturnValue('sess');
      mockUpdateChain();

      await DELETE(
        createDeleteRequest({ 'x-device-token': 'ps_sess_token' })
      );

      expect(db.query.deviceTokens.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('revoke with valid token but no device record found', () => {
    it('does not create new token when device record not found', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        tokenVersion: 3,
      });
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(getTokenType).mockReturnValue('dev');
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(undefined);
      mockUpdateChain();

      const response = await DELETE(
        createDeleteRequest({ 'x-device-token': 'ps_dev_token' })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.deviceToken).toBeUndefined();
      expect(createDeviceTokenRecord).not.toHaveBeenCalled();
    });
  });

  describe('revoke with deviceName null', () => {
    it('passes undefined for deviceName when null', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        tokenVersion: 3,
      });
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(getTokenType).mockReturnValue('dev');
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue({
        deviceId: 'dev-abc',
        platform: 'desktop',
        deviceName: null,
      });
      vi.mocked(createDeviceTokenRecord).mockResolvedValue({
        token: 'new_token',
        id: 'new-id',
        // @ts-expect-error - test mock with extra properties
        tokenHash: 'hashed_new_token',
      });
      vi.mocked(revokeExpiredDeviceTokens).mockResolvedValue(undefined as never);
      mockUpdateChain();

      await DELETE(
        createDeleteRequest({ 'x-device-token': 'ps_dev_token' })
      );

      expect(createDeviceTokenRecord).toHaveBeenCalledWith(
        'user-1',
        'dev-abc',
        'desktop',
        4,
        expect.objectContaining({
          deviceName: undefined,
        })
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 when user query throws', async () => {
      vi.mocked(db.query.users.findFirst).mockRejectedValueOnce(new Error('DB error'));

      const response = await DELETE(createDeleteRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to revoke devices');
    });
  });
});
