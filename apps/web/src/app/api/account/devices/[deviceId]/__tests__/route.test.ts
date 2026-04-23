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
      deviceTokens: { findFirst: vi.fn() },
    },
  },
  deviceTokens: {
    id: 'id',
    tokenHash: 'tokenHash',
  },
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/secure-compare', () => ({
  secureCompare: vi.fn(),
}));

vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn((token: string) => `hashed_${token}`),
}));

vi.mock('@pagespace/lib/device-auth-utils', () => ({
  revokeDeviceToken: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ userId: 'user-1', email: 'test@example.com' }),
  logTokenActivity: vi.fn(),
}));

import { DELETE } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { secureCompare } from '@pagespace/lib/auth/secure-compare';
import { hashToken } from '@pagespace/lib/auth';
import { revokeDeviceToken } from '@pagespace/lib/auth/device-auth-utils';
import { getActorInfo, logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';

// Test helpers
const mockSessionAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (deviceId: string) => ({
  params: Promise.resolve({ deviceId }),
});

const createRequest = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/account/devices/device-1', {
    method: 'DELETE',
    headers,
  });

const mockDevice = (overrides: Record<string, unknown> = {}) => ({
  id: 'device-1',
  userId: 'user-1',
  platform: 'desktop',
  deviceName: 'My MacBook',
  tokenHash: 'hashed_device_token',
  tokenPrefix: 'ps_dev_',
  createdAt: new Date('2024-01-01'),
  expiresAt: new Date('2025-01-01'),
  tokenVersion: 0,
  trustScore: 1.0,
  suspiciousActivityCount: 0,
  lastUsedAt: null,
  revokedAt: null,
  revokedReason: null,
  userAgent: null,
  ipAddress: null,
  lastIpAddress: null,
  location: null,
  replacedByTokenId: null,
  ...overrides,
});

// ============================================================================
// DELETE /api/account/devices/[deviceId]
// ============================================================================

describe('DELETE /api/account/devices/[deviceId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('returns auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(createRequest(), createContext('device-1'));

      expect(response.status).toBe(401);
    });

    it('uses session-only auth with CSRF', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(mockDevice() as never);
      vi.mocked(secureCompare).mockReturnValue(false);
      vi.mocked(revokeDeviceToken).mockResolvedValue(undefined);

      const request = createRequest();
      await DELETE(request, createContext('device-1'));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('params handling', () => {
    it('awaits params Promise to get deviceId', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(mockDevice({ id: 'custom-device-id' }) as never);
      vi.mocked(secureCompare).mockReturnValue(false);
      vi.mocked(revokeDeviceToken).mockResolvedValue(undefined);

      await DELETE(createRequest(), createContext('custom-device-id'));

      expect(revokeDeviceToken).toHaveBeenCalledWith('custom-device-id', 'user_action');
    });
  });

  describe('device not found', () => {
    it('returns 404 when device not found', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(undefined);

      const response = await DELETE(createRequest(), createContext('nonexistent'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Device not found');
    });
  });

  describe('authorization', () => {
    it('returns 403 when device belongs to another user', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(
        // @ts-expect-error - partial mock data
        mockDevice({ userId: 'other-user' })
      );

      const response = await DELETE(createRequest(), createContext('device-1'));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('current device detection', () => {
    it('returns requiresLogout=true when revoking current device', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(
        // @ts-expect-error - partial mock data
        mockDevice({ tokenHash: 'hashed_my-current-token' })
      );
      vi.mocked(secureCompare).mockReturnValue(true);
      vi.mocked(revokeDeviceToken).mockResolvedValue(undefined);

      const response = await DELETE(
        createRequest({ 'x-device-token': 'my-current-token' }),
        createContext('device-1')
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.requiresLogout).toBe(true);
      expect(hashToken).toHaveBeenCalledWith('my-current-token');
    });

    it('returns requiresLogout=false when revoking other device', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(
        // @ts-expect-error - partial mock data
        mockDevice({ tokenHash: 'hashed_other-device-token' })
      );
      vi.mocked(secureCompare).mockReturnValue(false);
      vi.mocked(revokeDeviceToken).mockResolvedValue(undefined);

      const response = await DELETE(
        createRequest({ 'x-device-token': 'my-current-token' }),
        createContext('device-1')
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.requiresLogout).toBe(false);
    });

    it('returns requiresLogout=false when no x-device-token header', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(mockDevice() as never);
      vi.mocked(revokeDeviceToken).mockResolvedValue(undefined);

      const response = await DELETE(createRequest(), createContext('device-1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.requiresLogout).toBe(false);
    });

    it('returns requiresLogout=false when device has no tokenHash', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(
        // @ts-expect-error - partial mock data
        mockDevice({ tokenHash: null })
      );
      vi.mocked(revokeDeviceToken).mockResolvedValue(undefined);

      const response = await DELETE(
        createRequest({ 'x-device-token': 'some-token' }),
        createContext('device-1')
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.requiresLogout).toBe(false);
    });
  });

  describe('successful revocation', () => {
    beforeEach(() => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(mockDevice() as never);
      vi.mocked(secureCompare).mockReturnValue(false);
      vi.mocked(revokeDeviceToken).mockResolvedValue(undefined);
    });

    it('calls revokeDeviceToken with correct args', async () => {
      await DELETE(createRequest(), createContext('device-1'));

      expect(revokeDeviceToken).toHaveBeenCalledWith('device-1', 'user_action');
    });

    it('returns success message', async () => {
      const response = await DELETE(createRequest(), createContext('device-1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Device revoked successfully');
    });

    it('logs activity for audit trail', async () => {
      await DELETE(createRequest(), createContext('device-1'));

      expect(getActorInfo).toHaveBeenCalledWith('user-1');
      const activityArgs = vi.mocked(logTokenActivity).mock.calls[0];
      expect(activityArgs[0]).toBe('user-1');
      expect(activityArgs[1]).toBe('token_revoke');
      expect(activityArgs[2]).toEqual({
        tokenId: 'device-1',
        tokenType: 'device',
        tokenName: 'My MacBook',
        deviceInfo: 'desktop - My MacBook',
      });
      expect(activityArgs[3]).toEqual({ userId: 'user-1', email: 'test@example.com' });
    });

    it('uses undefined for tokenName when deviceName is null', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(
        // @ts-expect-error - partial mock data
        mockDevice({ deviceName: null })
      );

      await DELETE(createRequest(), createContext('device-1'));

      const activityArgs = vi.mocked(logTokenActivity).mock.calls[0];
      expect(activityArgs[0]).toBe('user-1');
      expect(activityArgs[1]).toBe('token_revoke');
      expect(activityArgs[2]).toEqual({
        tokenId: 'device-1',
        tokenType: 'device',
        tokenName: undefined,
        deviceInfo: 'desktop - Unknown',
      });
      expect(activityArgs[3]).toEqual({ userId: 'user-1', email: 'test@example.com' });
    });

    it('uses Unknown for platform when platform is null', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(
        // @ts-expect-error - partial mock data
        mockDevice({ platform: null })
      );

      await DELETE(createRequest(), createContext('device-1'));

      const activityArgs = vi.mocked(logTokenActivity).mock.calls[0];
      expect(activityArgs[0]).toBe('user-1');
      expect(activityArgs[1]).toBe('token_revoke');
      expect(activityArgs[2]).toEqual({
        tokenId: 'device-1',
        tokenType: 'device',
        tokenName: 'My MacBook',
        deviceInfo: 'Unknown - My MacBook',
      });
      expect(activityArgs[3]).toEqual({ userId: 'user-1', email: 'test@example.com' });
    });
  });

  describe('error handling', () => {
    it('returns 500 when database query throws', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockRejectedValueOnce(
        new Error('DB error')
      );

      const response = await DELETE(createRequest(), createContext('device-1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to revoke device');
    });

    it('returns 500 when revokeDeviceToken throws', async () => {
      vi.mocked(db.query.deviceTokens.findFirst).mockResolvedValue(mockDevice() as never);
      vi.mocked(secureCompare).mockReturnValue(false);
      vi.mocked(revokeDeviceToken).mockRejectedValueOnce(new Error('Revocation failed'));

      const response = await DELETE(createRequest(), createContext('device-1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to revoke device');
    });
  });
});
