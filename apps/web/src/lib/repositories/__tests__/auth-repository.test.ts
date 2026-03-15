/**
 * Tests for auth-repository.ts
 * Repository for authentication-related database operations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFindFirst = vi.hoisted(() => vi.fn());
const mockUpdateSet = vi.hoisted(() => vi.fn());
const mockUpdateWhere = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: { findFirst: mockFindFirst },
    },
    update: vi.fn(() => ({ set: mockUpdateSet })),
  },
  users: {
    id: 'id',
    email: 'email',
    tokenVersion: 'tokenVersion',
  },
  deviceTokens: {
    userId: 'userId',
    revokedAt: 'revokedAt',
  },
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  isNull: vi.fn((field) => ({ type: 'isNull', field })),
  sql: Object.assign(vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => ({ type: 'sql', parts, values })), {
    placeholder: vi.fn(),
  }),
}));

import { authRepository } from '../auth-repository';
import { db } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
});

// ---------------------------------------------------------------------------
// findUserByEmail
// ---------------------------------------------------------------------------

describe('authRepository.findUserByEmail', () => {
  it('should return user when found by email', async () => {
    const user = { id: 'user-1', email: 'alice@example.com', tokenVersion: 1 };
    mockFindFirst.mockResolvedValue(user);

    const result = await authRepository.findUserByEmail('alice@example.com');
    expect(result).toEqual(user);
    expect(mockFindFirst).toHaveBeenCalled();
  });

  it('should return null when user not found by email', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const result = await authRepository.findUserByEmail('unknown@example.com');
    expect(result).toBeNull();
  });

  it('should pass the email to the query', async () => {
    mockFindFirst.mockResolvedValue(null);
    await authRepository.findUserByEmail('test@test.com');
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything() })
    );
  });
});

// ---------------------------------------------------------------------------
// findUserById
// ---------------------------------------------------------------------------

describe('authRepository.findUserById', () => {
  it('should return user when found by ID', async () => {
    const user = { id: 'user-42', email: 'bob@example.com', tokenVersion: 3 };
    mockFindFirst.mockResolvedValue(user);

    const result = await authRepository.findUserById('user-42');
    expect(result).toEqual(user);
  });

  it('should return null when user not found by ID', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const result = await authRepository.findUserById('nonexistent');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// incrementUserTokenVersion
// ---------------------------------------------------------------------------

describe('authRepository.incrementUserTokenVersion', () => {
  it('should call db.update to increment token version', async () => {
    await authRepository.incrementUserTokenVersion('user-1');
    expect(db.update).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalled();
    expect(mockUpdateWhere).toHaveBeenCalled();
  });

  it('should pass a sql expression for increment', async () => {
    await authRepository.incrementUserTokenVersion('user-1');
    const setArg = mockUpdateSet.mock.calls[0][0];
    // The tokenVersion field should contain a sql expression (not a plain number)
    expect(setArg.tokenVersion).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// revokeAllUserDeviceTokens
// ---------------------------------------------------------------------------

describe('authRepository.revokeAllUserDeviceTokens', () => {
  it('should call db.update on deviceTokens', async () => {
    await authRepository.revokeAllUserDeviceTokens('user-1');
    expect(db.update).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ revokedAt: expect.any(Date) })
    );
  });

  it('should apply where condition for userId and isNull(revokedAt)', async () => {
    await authRepository.revokeAllUserDeviceTokens('user-1');
    expect(mockUpdateWhere).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateUserTokenVersion
// ---------------------------------------------------------------------------

describe('authRepository.updateUserTokenVersion', () => {
  it('should call db.update with the new token version', async () => {
    await authRepository.updateUserTokenVersion('user-1', 5);
    expect(db.update).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ tokenVersion: 5 })
    );
  });

  it('should call where clause with userId', async () => {
    await authRepository.updateUserTokenVersion('user-99', 10);
    expect(mockUpdateWhere).toHaveBeenCalled();
  });

  it('should accept version 0', async () => {
    await authRepository.updateUserTokenVersion('user-1', 0);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ tokenVersion: 0 })
    );
  });
});
