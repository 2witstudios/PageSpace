import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    revokeDeviceSessions: vi.fn(),
    revokeAllUserSessions: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  validateOrCreateDeviceToken: vi.fn(),
  loggers: {
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import { revokeSessionsForLogin, createWebDeviceToken } from '../device-auth-helpers';
import { sessionService } from '@pagespace/lib/auth';
import { validateOrCreateDeviceToken } from '@pagespace/lib/server';

describe('device-auth-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('revokeSessionsForLogin', () => {
    it('with deviceId calls revokeDeviceSessions', async () => {
      vi.mocked(sessionService.revokeDeviceSessions).mockResolvedValue(1);

      const count = await revokeSessionsForLogin('user-1', 'device-abc', 'new_login', 'Google OAuth');

      expect(sessionService.revokeDeviceSessions).toHaveBeenCalledWith('user-1', 'device-abc', 'new_login');
      expect(sessionService.revokeAllUserSessions).not.toHaveBeenCalled();
      expect(count).toBe(1);
    });

    it('without deviceId falls back to revokeAllUserSessions', async () => {
      vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(2);

      const count = await revokeSessionsForLogin('user-1', undefined, 'new_login', 'password');

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith('user-1', 'new_login');
      expect(sessionService.revokeDeviceSessions).not.toHaveBeenCalled();
      expect(count).toBe(2);
    });
  });

  describe('createWebDeviceToken', () => {
    it('calls validateOrCreateDeviceToken with platform web and returns token', async () => {
      vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
        deviceToken: 'ps_dev_test123',
        deviceTokenRecordId: 'record-1',
        isNew: true,
      });

      const token = await createWebDeviceToken({
        userId: 'user-1',
        deviceId: 'device-abc',
        tokenVersion: 1,
        deviceName: 'Chrome',
      });

      expect(token).toBe('ps_dev_test123');
      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'web',
          providedDeviceToken: null,
          userId: 'user-1',
          deviceId: 'device-abc',
        }),
      );
    });

    it('normalizes undefined providedDeviceToken to null', async () => {
      vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
        deviceToken: 'ps_dev_test123',
        deviceTokenRecordId: 'record-1',
        isNew: true,
      });

      await createWebDeviceToken({
        userId: 'user-1',
        deviceId: 'device-abc',
        tokenVersion: 1,
        providedDeviceToken: undefined,
      });

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({ providedDeviceToken: null }),
      );
    });

    it('propagates errors', async () => {
      vi.mocked(validateOrCreateDeviceToken).mockRejectedValue(new Error('DB error'));

      await expect(
        createWebDeviceToken({ userId: 'user-1', deviceId: 'device-abc', tokenVersion: 1 }),
      ).rejects.toThrow('DB error');
    });
  });
});
