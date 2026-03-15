import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db', () => {
  const eq = vi.fn((a, b) => ({ op: 'eq', a, b }));
  const and = vi.fn((...args: unknown[]) => ({ op: 'and', args }));
  const isNull = vi.fn((a) => ({ op: 'isNull', a }));
  const lt = vi.fn((a, b) => ({ op: 'lt', a, b }));
  const gt = vi.fn((a, b) => ({ op: 'gt', a, b }));
  const or = vi.fn((...args: unknown[]) => ({ op: 'or', args }));
  const sql = vi.fn();
  const deviceTokens = {
    id: 'deviceTokens.id',
    userId: 'deviceTokens.userId',
    deviceId: 'deviceTokens.deviceId',
    platform: 'deviceTokens.platform',
    tokenHash: 'deviceTokens.tokenHash',
    tokenPrefix: 'deviceTokens.tokenPrefix',
    tokenVersion: 'deviceTokens.tokenVersion',
    revokedAt: 'deviceTokens.revokedAt',
    revokedReason: 'deviceTokens.revokedReason',
    expiresAt: 'deviceTokens.expiresAt',
    lastUsedAt: 'deviceTokens.lastUsedAt',
    lastIpAddress: 'deviceTokens.lastIpAddress',
    $inferSelect: {},
  };
  const users = {
    id: 'users.id',
    tokenVersion: 'users.tokenVersion',
  };

  return {
    db: {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(),
          })),
        })),
      })),
      query: {
        deviceTokens: {
          findFirst: vi.fn(),
          findMany: vi.fn(),
        },
        users: {
          findFirst: vi.fn(),
        },
      },
    },
    deviceTokens,
    users,
    eq,
    and,
    isNull,
    lt,
    gt,
    or,
    sql,
  };
});

vi.mock('../token-utils', () => ({
  hashToken: vi.fn((t: string) => `hashed_${t}`),
  getTokenPrefix: vi.fn((t: string) => t.substring(0, 12)),
}));

vi.mock('../opaque-tokens', () => ({
  generateOpaqueToken: vi.fn(() => ({ token: 'ps_dev_mock_token_123', hash: 'hash123' })),
  isValidTokenFormat: vi.fn((t: string) => t.startsWith('ps_')),
  getTokenType: vi.fn((t: string) => {
    if (t.startsWith('ps_dev_')) return 'dev';
    if (t.startsWith('ps_ses_')) return 'ses';
    return 'unknown';
  }),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid-id'),
}));

const mockAtomicValidateOrCreate = vi.fn();
vi.mock('@pagespace/db/transactions/auth-transactions', () => ({
  atomicValidateOrCreateDeviceToken: (...args: unknown[]) => mockAtomicValidateOrCreate(...args),
}));

import { db } from '@pagespace/db';
import {
  TOKEN_LIFETIMES,
  generateDeviceToken,
  createDeviceTokenRecord,
  revokeExpiredDeviceTokens,
  validateDeviceToken,
  updateDeviceTokenActivity,
  revokeDeviceToken,
  revokeDeviceTokenByValue,
  revokeDeviceTokensByDevice,
  revokeAllUserDeviceTokens,
  getUserDeviceTokens,
  rotateDeviceToken,
  cleanupExpiredDeviceTokens,
  validateOrCreateDeviceToken,
} from '../device-auth-utils';

// Type helpers to access mock functions
const mockDb = vi.mocked(db);

describe('device-auth-utils @scaffold', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset default mock implementations
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'record-id' }]),
      }),
    });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
  });

  describe('TOKEN_LIFETIMES', () => {
    it('should have expected lifetime values', () => {
      expect(TOKEN_LIFETIMES.ACCESS_TOKEN).toBe('15m');
      expect(TOKEN_LIFETIMES.REFRESH_TOKEN_DEFAULT).toBe('7d');
      expect(TOKEN_LIFETIMES.REFRESH_TOKEN_REMEMBERED).toBe('30d');
      expect(TOKEN_LIFETIMES.DEVICE_TOKEN).toBe('90d');
    });
  });

  describe('generateDeviceToken', () => {
    it('should return an opaque token string', () => {
      const token = generateDeviceToken();
      expect(token).toBe('ps_dev_mock_token_123');
    });
  });

  describe('createDeviceTokenRecord', () => {
    it('should create a device token record and return id + token', async () => {
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'record-id-1' }]);
      const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
      mockDb.insert.mockReturnValue({ values: mockValues });

      const result = await createDeviceTokenRecord(
        'user-1', 'device-1', 'web', 1,
        { deviceName: 'Chrome', userAgent: 'Mozilla/5.0', ipAddress: '1.2.3.4', location: 'US' }
      );

      expect(result.id).toBe('record-id-1');
      expect(result.token).toBe('ps_dev_mock_token_123');
    });

    it('should work with empty metadata', async () => {
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'record-id-2' }]);
      const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
      mockDb.insert.mockReturnValue({ values: mockValues });

      const result = await createDeviceTokenRecord('user-1', 'device-1', 'desktop', 1);
      expect(result.id).toBe('record-id-2');
    });
  });

  describe('revokeExpiredDeviceTokens', () => {
    it('should return count of revoked tokens', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ rowCount: 3 }),
        }),
      });

      const count = await revokeExpiredDeviceTokens('user-1', 'device-1', 'web');
      expect(count).toBe(3);
    });

    it('should return 0 when no tokens revoked', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ rowCount: 0 }),
        }),
      });

      const count = await revokeExpiredDeviceTokens('user-1', 'device-1', 'ios');
      expect(count).toBe(0);
    });

    it('should return 0 when rowCount is undefined', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({}),
        }),
      });

      const count = await revokeExpiredDeviceTokens('user-1', 'device-1', 'android');
      expect(count).toBe(0);
    });
  });

  describe('validateDeviceToken', () => {
    it('should return null for invalid format', async () => {
      const result = await validateDeviceToken('invalid-token');
      expect(result).toBeNull();
    });

    it('should return null for non-dev token type', async () => {
      const result = await validateDeviceToken('ps_ses_something');
      expect(result).toBeNull();
    });

    it('should return null when token not found in DB', async () => {
      mockDb.query.deviceTokens.findFirst.mockResolvedValueOnce(null);

      const result = await validateDeviceToken('ps_dev_valid_token');
      expect(result).toBeNull();
    });

    it('should return null when user not found', async () => {
      mockDb.query.deviceTokens.findFirst.mockResolvedValueOnce({ userId: 'user-1', tokenVersion: 1 });
      mockDb.query.users.findFirst.mockResolvedValueOnce(null);

      const result = await validateDeviceToken('ps_dev_valid_token');
      expect(result).toBeNull();
    });

    it('should return null on tokenVersion mismatch', async () => {
      mockDb.query.deviceTokens.findFirst.mockResolvedValueOnce({ userId: 'user-1', tokenVersion: 1 });
      mockDb.query.users.findFirst.mockResolvedValueOnce({ tokenVersion: 2 });

      const result = await validateDeviceToken('ps_dev_valid_token');
      expect(result).toBeNull();
    });

    it('should return device token when valid', async () => {
      const deviceToken = { userId: 'user-1', tokenVersion: 1, id: 'dt-1' };
      mockDb.query.deviceTokens.findFirst.mockResolvedValueOnce(deviceToken);
      mockDb.query.users.findFirst.mockResolvedValueOnce({ tokenVersion: 1 });

      const result = await validateDeviceToken('ps_dev_valid_token');
      expect(result).toEqual(deviceToken);
    });

    it('should return null on error', async () => {
      mockDb.query.deviceTokens.findFirst.mockRejectedValueOnce(new Error('DB error'));

      const result = await validateDeviceToken('ps_dev_valid_token');
      expect(result).toBeNull();
    });
  });

  describe('updateDeviceTokenActivity', () => {
    it('should resolve without error for valid tokenId', async () => {
      const mockWhere = vi.fn().mockResolvedValue(undefined);
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      mockDb.update.mockReturnValue({ set: mockSet });

      // void function — contract is "resolves without throwing"
      await expect(updateDeviceTokenActivity('token-id-1')).resolves.toBeUndefined();
    });

    it('should resolve without error when ipAddress is provided', async () => {
      const mockWhere = vi.fn().mockResolvedValue(undefined);
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      mockDb.update.mockReturnValue({ set: mockSet });

      await expect(updateDeviceTokenActivity('token-id-1', '10.0.0.1')).resolves.toBeUndefined();
    });
  });

  describe('revokeDeviceToken', () => {
    it('should resolve without error for valid inputs', async () => {
      const mockWhere = vi.fn().mockResolvedValue(undefined);
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      mockDb.update.mockReturnValue({ set: mockSet });

      // void function — contract is "resolves without throwing"
      await expect(revokeDeviceToken('token-id-1', 'user_action')).resolves.toBeUndefined();
    });
  });

  describe('revokeDeviceTokenByValue', () => {
    it('should return true when token revoked', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ rowCount: 1 }),
        }),
      });

      const result = await revokeDeviceTokenByValue('ps_dev_token', 'logout');
      expect(result).toBe(true);
    });

    it('should return false when token not found', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ rowCount: 0 }),
        }),
      });

      const result = await revokeDeviceTokenByValue('ps_dev_token');
      expect(result).toBe(false);
    });
  });

  describe('revokeDeviceTokensByDevice', () => {
    it('should return count of revoked tokens', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ rowCount: 2 }),
        }),
      });

      const count = await revokeDeviceTokensByDevice('user-1', 'dev-1', 'desktop');
      expect(count).toBe(2);
    });
  });

  describe('revokeAllUserDeviceTokens', () => {
    it('should resolve without error for valid user', async () => {
      const mockWhere = vi.fn().mockResolvedValue(undefined);
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      mockDb.update.mockReturnValue({ set: mockSet });

      // void function — contract is "resolves without throwing"
      await expect(revokeAllUserDeviceTokens('user-1', 'token_version_change')).resolves.toBeUndefined();
    });
  });

  describe('getUserDeviceTokens', () => {
    it('should return active device tokens', async () => {
      const tokens = [
        { id: 'dt-1', userId: 'user-1', platform: 'web' },
        { id: 'dt-2', userId: 'user-1', platform: 'desktop' },
      ];
      mockDb.query.deviceTokens.findMany.mockResolvedValueOnce(tokens);

      const result = await getUserDeviceTokens('user-1');
      expect(result).toEqual(tokens);
    });

    it('should return empty array when no tokens', async () => {
      mockDb.query.deviceTokens.findMany.mockResolvedValueOnce([]);

      const result = await getUserDeviceTokens('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('rotateDeviceToken', () => {
    it('should return null when old token is invalid', async () => {
      mockDb.query.deviceTokens.findFirst.mockResolvedValueOnce(null);

      const result = await rotateDeviceToken('ps_dev_invalid', { ipAddress: '1.2.3.4' });
      expect(result).toBeNull();
    });

    it('should return null when user not found during rotation', async () => {
      const oldDeviceToken = {
        id: 'dt-old', userId: 'user-1', tokenVersion: 1, deviceId: 'dev-1',
        platform: 'web' as const, deviceName: 'Chrome', userAgent: 'UA',
        lastIpAddress: '1.1.1.1', location: 'US',
      };
      // validateDeviceToken finds device token, finds user
      mockDb.query.deviceTokens.findFirst.mockResolvedValueOnce(oldDeviceToken);
      mockDb.query.users.findFirst
        .mockResolvedValueOnce({ tokenVersion: 1 }) // validate step
        .mockResolvedValueOnce(null); // rotate step - user not found

      const result = await rotateDeviceToken('ps_dev_valid', { ipAddress: '2.3.4.5' });
      expect(result).toBeNull();
    });

    it('should return null on error during rotation', async () => {
      mockDb.query.deviceTokens.findFirst.mockRejectedValueOnce(new Error('DB error'));

      const result = await rotateDeviceToken('ps_dev_valid', {});
      expect(result).toBeNull();
    });
  });

  describe('cleanupExpiredDeviceTokens', () => {
    it('should return count of cleaned tokens', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: '1' }, { id: '2' }]),
          }),
        }),
      });

      const count = await cleanupExpiredDeviceTokens();
      expect(count).toBe(2);
    });

    it('should return 0 when no expired tokens', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const count = await cleanupExpiredDeviceTokens();
      expect(count).toBe(0);
    });
  });

  describe('validateOrCreateDeviceToken', () => {
    it('should delegate to atomicValidateOrCreateDeviceToken and return its result', async () => {
      mockAtomicValidateOrCreate.mockResolvedValueOnce({
        deviceToken: 'ps_dev_new_token',
        deviceTokenRecordId: 'record-id',
        isNew: true,
      });

      const result = await validateOrCreateDeviceToken({
        providedDeviceToken: null,
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        tokenVersion: 1,
      });

      expect(result).toEqual({
        deviceToken: 'ps_dev_new_token',
        deviceTokenRecordId: 'record-id',
        isNew: true,
      });
      expect(mockAtomicValidateOrCreate).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', deviceId: 'dev-1', platform: 'web' }),
        expect.objectContaining({ hashToken: expect.any(Function), generateDeviceToken: expect.any(Function) }),
      );
    });
  });
});
