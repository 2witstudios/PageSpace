import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Contract Tests for /api/users/search
//
// Mock at the SERVICE SEAM level: auth, db queries, and query-params utility
// ============================================================================

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

// Track all chained query builder calls
const mockLimit = vi.fn();
const mockWhere = vi.fn();
const mockLeftJoin = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn();

// Reset chains before each call
function _setupSelectChain(result: unknown[]) {
  mockLimit.mockResolvedValue(result);
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockLeftJoin.mockReturnValue({ where: mockWhere });
  mockFrom.mockReturnValue({ leftJoin: mockLeftJoin, where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
}

// We need separate chains for the three select calls
const profileSelectChain = {
  limit: vi.fn(),
  where: vi.fn(),
  leftJoin: vi.fn(),
  from: vi.fn(),
};

const emailSelectChain = {
  limit: vi.fn(),
  where: vi.fn(),
  from: vi.fn(),
};

const profileLookupChain = {
  limit: vi.fn(),
  where: vi.fn(),
  from: vi.fn(),
};

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ _eq: true, col, val })),
  and: vi.fn((...args: unknown[]) => ({ _and: true, args })),
  or: vi.fn((...args: unknown[]) => ({ _or: true, args })),
  ilike: vi.fn((col: unknown, val: unknown) => ({ _ilike: true, col, val })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: {
    id: 'users.id',
    email: 'users.email',
    name: 'users.name',
  },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  userProfiles: {
    userId: 'userProfiles.userId',
    username: 'userProfiles.username',
    displayName: 'userProfiles.displayName',
    bio: 'userProfiles.bio',
    avatarUrl: 'userProfiles.avatarUrl',
    isPublic: 'userProfiles.isPublic',
  },
}));

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn((_raw: string | null, opts: { defaultValue: number }) => opts.defaultValue),
}));

import { GET } from '../route';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';

// ============================================================================
// Test Helpers
// ============================================================================

function setupDbChains(
  profileResults: unknown[] = [],
  emailResults: unknown[] = [],
  profileLookupResults: unknown[] = [],
) {
  let selectCallCount = 0;

  // Profile query chain
  profileSelectChain.limit.mockResolvedValue(profileResults);
  profileSelectChain.where.mockReturnValue({ limit: profileSelectChain.limit });
  profileSelectChain.leftJoin.mockReturnValue({ where: profileSelectChain.where });
  profileSelectChain.from.mockReturnValue({ leftJoin: profileSelectChain.leftJoin });

  // Email query chain
  emailSelectChain.limit.mockResolvedValue(emailResults);
  emailSelectChain.where.mockReturnValue({ limit: emailSelectChain.limit });
  emailSelectChain.from.mockReturnValue({ where: emailSelectChain.where });

  // Profile lookup chain (for email results without existing profile match)
  profileLookupChain.limit.mockResolvedValue(profileLookupResults);
  profileLookupChain.where.mockReturnValue({ limit: profileLookupChain.limit });
  profileLookupChain.from.mockReturnValue({ where: profileLookupChain.where });

  vi.mocked(db.select).mockImplementation((..._args: unknown[]) => {
    selectCallCount++;
    if (selectCallCount === 1) {
      return { from: profileSelectChain.from } as never;
    } else if (selectCallCount === 2) {
      return { from: emailSelectChain.from } as never;
    } else {
      return { from: profileLookupChain.from } as never;
    }
  });
}

// ============================================================================
// GET /api/users/search
// ============================================================================

describe('GET /api/users/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({
      id: 'user_123',
      // @ts-expect-error - test mock with extra properties
      hasSessionBearerToken: false,
    });
    setupDbChains();
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(verifyAuth).mockResolvedValue(null);

      const request = new Request('https://example.com/api/users/search?q=test');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('validation', () => {
    it('should return empty users array when query is missing', async () => {
      const request = new Request('https://example.com/api/users/search');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ users: [] });
    });

    it('should return empty users array when query is too short (1 char)', async () => {
      const request = new Request('https://example.com/api/users/search?q=a');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ users: [] });
    });

    it('should return empty users array when query is empty string', async () => {
      const request = new Request('https://example.com/api/users/search?q=');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ users: [] });
    });
  });

  describe('profile search results', () => {
    it('should return profile results when found', async () => {
      const profileResults = [
        {
          userId: 'user_456',
          username: 'testuser',
          displayName: 'Test User',
          bio: 'A bio',
          avatarUrl: 'https://example.com/avatar.png',
          email: 'test@example.com',
        },
      ];
      setupDbChains(profileResults, []);

      const request = new Request('https://example.com/api/users/search?q=test');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.users).toHaveLength(1);
      expect(body.users[0]).toEqual({
        userId: 'user_456',
        username: 'testuser',
        displayName: 'Test User',
        bio: 'A bio',
        avatarUrl: 'https://example.com/avatar.png',
        email: 'test@example.com',
      });
    });
  });

  describe('email search results', () => {
    it('should add email result with existing profile when user not already in map', async () => {
      const emailResults = [
        { userId: 'user_789', email: 'exact@example.com', name: 'Email User' },
      ];
      const profileLookupResults = [
        {
          userId: 'user_789',
          username: 'emailuser',
          displayName: 'Email Display',
          bio: 'Email bio',
          avatarUrl: 'https://example.com/email-avatar.png',
          isPublic: true,
        },
      ];
      setupDbChains([], emailResults, profileLookupResults);

      const request = new Request('https://example.com/api/users/search?q=exact@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.users).toHaveLength(1);
      expect(body.users[0]).toEqual({
        userId: 'user_789',
        username: 'emailuser',
        displayName: 'Email Display',
        bio: 'Email bio',
        avatarUrl: 'https://example.com/email-avatar.png',
        email: 'exact@example.com',
      });
    });

    it('should add email result without profile (fallback display name from users.name)', async () => {
      const emailResults = [
        { userId: 'user_no_profile', email: 'noprofile@example.com', name: 'No Profile User' },
      ];
      setupDbChains([], emailResults, []);

      const request = new Request('https://example.com/api/users/search?q=noprofile@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.users).toHaveLength(1);
      expect(body.users[0]).toEqual({
        userId: 'user_no_profile',
        username: null,
        displayName: 'No Profile User',
        bio: null,
        avatarUrl: null,
        email: 'noprofile@example.com',
      });
    });

    it('should use "Unknown User" when email result has no profile and no name', async () => {
      const emailResults = [
        { userId: 'user_anon', email: 'anon@example.com', name: null },
      ];
      setupDbChains([], emailResults, []);

      const request = new Request('https://example.com/api/users/search?q=anon@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.users[0].displayName).toBe('Unknown User');
    });

    it('should not duplicate when email result user already exists in profile results', async () => {
      const profileResults = [
        {
          userId: 'user_dup',
          username: 'dupuser',
          displayName: 'Dup User',
          bio: null,
          avatarUrl: null,
          email: 'dup@example.com',
        },
      ];
      const emailResults = [
        { userId: 'user_dup', email: 'dup@example.com', name: 'Dup User' },
      ];
      setupDbChains(profileResults, emailResults);

      const request = new Request('https://example.com/api/users/search?q=dup@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.users).toHaveLength(1);
    });
  });

  describe('combined results', () => {
    it('should combine profile and email results without duplicates', async () => {
      const profileResults = [
        {
          userId: 'user_1',
          username: 'profileuser',
          displayName: 'Profile User',
          bio: 'bio1',
          avatarUrl: null,
          email: 'profile@example.com',
        },
      ];
      const emailResults = [
        { userId: 'user_2', email: 'email@example.com', name: 'Email User' },
      ];
      setupDbChains(profileResults, emailResults, []);

      const request = new Request('https://example.com/api/users/search?q=email@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.users).toHaveLength(2);
    });
  });

  describe('security audit', () => {
    it('should log audit event on successful search', async () => {
      const request = new Request('https://example.com/api/users/search?q=test');
      await GET(request);

      expect(auditRequest).toHaveBeenCalledWith(
        request,
        { eventType: 'data.read', userId: 'user_123', resourceType: 'user_search', resourceId: 'user_123', details: { queryLength: 4, resultCount: 0 } }
      );
    });

    it('should not log audit event when query too short', async () => {
      const request = new Request('https://example.com/api/users/search?q=a');
      await GET(request);

      expect(auditRequest).not.toHaveBeenCalled();
    });

    it('should not log audit event when auth fails', async () => {
      vi.mocked(verifyAuth).mockResolvedValue(null);

      const request = new Request('https://example.com/api/users/search?q=test');
      await GET(request);

      expect(auditRequest).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when database throws', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Database connection lost');
      });

      const request = new Request('https://example.com/api/users/search?q=test');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to search users');
    });

    it('should log error when database throws', async () => {
      const error = new Error('Query failed');
      vi.mocked(db.select).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/users/search?q=test');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error searching users:', error);
    });
  });
});
