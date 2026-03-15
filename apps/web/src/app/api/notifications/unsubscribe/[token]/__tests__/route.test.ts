/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Contract Tests for GET /api/notifications/unsubscribe/[token]
//
// Tests the route handler's contract for one-click email unsubscribe.
// Mocks database and auth utilities.
// ============================================================================

// Use vi.hoisted so mock fns are available inside vi.mock factories
const {
  mockFindFirstUnsubscribeToken,
  mockFindFirstPreference,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockInsertValues,
  mockInsert,
} = vi.hoisted(() => {
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
  const mockFindFirstUnsubscribeToken = vi.fn();
  const mockFindFirstPreference = vi.fn();
  return {
    mockFindFirstUnsubscribeToken,
    mockFindFirstPreference,
    mockUpdateWhere,
    mockUpdateSet,
    mockUpdate,
    mockInsertValues,
    mockInsert,
  };
});

// Mock next/server before importing route
vi.mock('next/server', () => {
  class MockNextResponse extends Response {
    static json(data: unknown, init?: ResponseInit) {
      return new Response(JSON.stringify(data), {
        status: init?.status ?? 200,
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers || {}),
        },
      });
    }
    static redirect(url: string | URL, status = 307) {
      return new Response(null, {
        status,
        headers: { location: url.toString() },
      });
    }
  }
  return { NextResponse: MockNextResponse };
});

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      emailUnsubscribeTokens: {
        findFirst: mockFindFirstUnsubscribeToken,
      },
      emailNotificationPreferences: {
        findFirst: mockFindFirstPreference,
      },
    },
    update: mockUpdate,
    insert: mockInsert,
  },
  emailNotificationPreferences: {
    userId: 'userId',
    notificationType: 'notificationType',
    emailEnabled: 'emailEnabled',
    updatedAt: 'updatedAt',
  },
  emailUnsubscribeTokens: {
    tokenHash: 'tokenHash',
    expiresAt: 'expiresAt',
    usedAt: 'usedAt',
  },
  eq: vi.fn((...args: any[]) => ['eq', ...args]),
  and: vi.fn((...args: any[]) => ['and', ...args]),
  gt: vi.fn((...args: any[]) => ['gt', ...args]),
  isNull: vi.fn((...args: any[]) => ['isNull', ...args]),
}));

vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import { GET } from '../route';
import { hashToken } from '@pagespace/lib/auth';
import { loggers } from '@pagespace/lib/server';

// ============================================================================
// Test Helpers
// ============================================================================

const createContext = (token: string) => ({
  params: Promise.resolve({ token }),
});

const createUnsubscribeRecord = (overrides: Partial<{
  userId: string;
  notificationType: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}> = {}) => ({
  userId: overrides.userId ?? 'user_123',
  notificationType: overrides.notificationType ?? 'PAGE_SHARED',
  tokenHash: overrides.tokenHash ?? 'hashed_token_abc',
  expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86400000),
  usedAt: overrides.usedAt ?? null,
});

// ============================================================================
// GET /api/notifications/unsubscribe/[token] - Contract Tests
// ============================================================================

describe('GET /api/notifications/unsubscribe/[token]', () => {
  const mockToken = 'raw_token_abc';
  const mockTokenHash = 'hashed_token_abc';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hashToken).mockReturnValue(mockTokenHash);
    mockFindFirstUnsubscribeToken.mockResolvedValue(null);
    mockFindFirstPreference.mockResolvedValue(null);
    mockUpdateWhere.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockInsertValues.mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values: mockInsertValues });

    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
  });

  describe('invalid or expired token', () => {
    it('should return 400 when token is not found', async () => {
      mockFindFirstUnsubscribeToken.mockResolvedValue(null);

      const request = new Request('https://example.com/api/notifications/unsubscribe/invalid_token');
      const response = await GET(request, createContext('invalid_token'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid or expired unsubscribe link');
    });

    it('should hash the token before lookup', async () => {
      mockFindFirstUnsubscribeToken.mockResolvedValue(null);

      const request = new Request('https://example.com/api/notifications/unsubscribe/my_token');
      await GET(request, createContext('my_token'));

      expect(hashToken).toHaveBeenCalledWith('my_token');
    });

    it('should log warning for invalid token attempts', async () => {
      mockFindFirstUnsubscribeToken.mockResolvedValue(null);

      const request = new Request('https://example.com/api/notifications/unsubscribe/invalid');
      await GET(request, createContext('invalid'));

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Invalid or expired unsubscribe token attempted'
      );
    });
  });

  describe('successful unsubscribe with existing preference', () => {
    it('should update existing preference to disabled', async () => {
      const record = createUnsubscribeRecord({ notificationType: 'PAGE_SHARED' });
      mockFindFirstUnsubscribeToken.mockResolvedValue(record);
      mockFindFirstPreference.mockResolvedValue({
        userId: 'user_123',
        notificationType: 'PAGE_SHARED',
        emailEnabled: true,
      });

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      const response = await GET(request, createContext(mockToken));

      expect(response.status).toBe(307);
      // update called twice: once to mark token used, once to update preference
      expect(mockUpdate).toHaveBeenCalledTimes(2);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('should mark the token as used', async () => {
      const record = createUnsubscribeRecord();
      mockFindFirstUnsubscribeToken.mockResolvedValue(record);
      mockFindFirstPreference.mockResolvedValue(null);

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      await GET(request, createContext(mockToken));

      // First update call marks the token as used
      expect(mockUpdate).toHaveBeenCalled();
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ usedAt: expect.any(Date) })
      );
    });
  });

  describe('successful unsubscribe with new preference', () => {
    it('should insert new preference when none exists', async () => {
      const record = createUnsubscribeRecord({ notificationType: 'DRIVE_INVITED' });
      mockFindFirstUnsubscribeToken.mockResolvedValue(record);
      mockFindFirstPreference.mockResolvedValue(null);

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      const response = await GET(request, createContext(mockToken));

      expect(response.status).toBe(307);
      expect(mockInsert).toHaveBeenCalled();
      expect(mockInsertValues).toHaveBeenCalledWith({
        userId: 'user_123',
        notificationType: 'DRIVE_INVITED',
        emailEnabled: false,
      });
    });
  });

  describe('invalid notification type in token', () => {
    it('should return 400 when token has missing userId', async () => {
      const record = createUnsubscribeRecord();
      record.userId = '';
      mockFindFirstUnsubscribeToken.mockResolvedValue(record);

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      const response = await GET(request, createContext(mockToken));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid unsubscribe token');
    });

    it('should return 400 when token has missing notificationType', async () => {
      const record = createUnsubscribeRecord();
      record.notificationType = '';
      mockFindFirstUnsubscribeToken.mockResolvedValue(record);

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      const response = await GET(request, createContext(mockToken));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid unsubscribe token');
    });
  });

  describe('redirect URL', () => {
    it('should redirect to unsubscribe-success page with notification type', async () => {
      const record = createUnsubscribeRecord({ notificationType: 'PAGE_SHARED' });
      mockFindFirstUnsubscribeToken.mockResolvedValue(record);
      mockFindFirstPreference.mockResolvedValue(null);

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      const response = await GET(request, createContext(mockToken));

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/unsubscribe-success');
      expect(location).toContain('type=PAGE_SHARED');
    });

    it('should use NEXT_PUBLIC_APP_URL for redirect base', async () => {
      process.env.NEXT_PUBLIC_APP_URL = 'https://my-app.example.com';
      const record = createUnsubscribeRecord({ notificationType: 'DRIVE_JOINED' });
      mockFindFirstUnsubscribeToken.mockResolvedValue(record);
      mockFindFirstPreference.mockResolvedValue(null);

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      const response = await GET(request, createContext(mockToken));

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('https://my-app.example.com/unsubscribe-success');
    });

    it('should default to localhost:3000 when NEXT_PUBLIC_APP_URL is not set', async () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      const record = createUnsubscribeRecord({ notificationType: 'CONNECTION_REQUEST' });
      mockFindFirstUnsubscribeToken.mockResolvedValue(record);
      mockFindFirstPreference.mockResolvedValue(null);

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      const response = await GET(request, createContext(mockToken));

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('http://localhost:3000/unsubscribe-success');
    });
  });

  describe('valid notification types', () => {
    const validTypes = [
      'PERMISSION_GRANTED',
      'PERMISSION_REVOKED',
      'PERMISSION_UPDATED',
      'PAGE_SHARED',
      'DRIVE_INVITED',
      'DRIVE_JOINED',
      'DRIVE_ROLE_CHANGED',
      'CONNECTION_REQUEST',
      'CONNECTION_ACCEPTED',
      'CONNECTION_REJECTED',
      'NEW_DIRECT_MESSAGE',
    ];

    it.each(validTypes)(
      'should accept %s as a valid notification type',
      async (notificationType) => {
        const record = createUnsubscribeRecord({ notificationType });
        mockFindFirstUnsubscribeToken.mockResolvedValue(record);
        mockFindFirstPreference.mockResolvedValue(null);

        const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
        const response = await GET(request, createContext(mockToken));

        expect(response.status).toBe(307);
      }
    );

    it('should return 400 for an invalid notification type', async () => {
      const record = createUnsubscribeRecord({ notificationType: 'INVALID_TYPE' });
      mockFindFirstUnsubscribeToken.mockResolvedValue(record);
      mockFindFirstPreference.mockResolvedValue(null);

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      const response = await GET(request, createContext(mockToken));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid notification type');
    });

    it('should log warning for invalid notification type', async () => {
      const record = createUnsubscribeRecord({ notificationType: 'BOGUS_TYPE' });
      mockFindFirstUnsubscribeToken.mockResolvedValue(record);
      mockFindFirstPreference.mockResolvedValue(null);

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      await GET(request, createContext(mockToken));

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Invalid notification type in unsubscribe token',
        { notificationType: 'BOGUS_TYPE' }
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query throws', async () => {
      mockFindFirstUnsubscribeToken.mockRejectedValue(new Error('Database error'));

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      const response = await GET(request, createContext(mockToken));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to process unsubscribe request');
    });

    it('should log error when database query throws', async () => {
      const error = new Error('Database error');
      mockFindFirstUnsubscribeToken.mockRejectedValue(error);

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      await GET(request, createContext(mockToken));

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error processing unsubscribe:',
        error
      );
    });

    it('should return 500 when preference lookup throws', async () => {
      const record = createUnsubscribeRecord();
      mockFindFirstUnsubscribeToken.mockResolvedValue(record);
      mockFindFirstPreference.mockRejectedValue(new Error('Update failed'));

      const request = new Request('https://example.com/api/notifications/unsubscribe/abc');
      const response = await GET(request, createContext(mockToken));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to process unsubscribe request');
    });
  });
});
