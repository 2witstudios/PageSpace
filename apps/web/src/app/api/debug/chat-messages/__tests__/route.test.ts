/**
 * Contract tests for GET/POST /api/debug/chat-messages
 *
 * Verifies production guard, authentication, authorization,
 * and success paths for the debug endpoint.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

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
  }
  return { NextResponse: MockNextResponse };
});

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock permissions (boundary)
vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserViewPage: vi.fn(),
    canUserEditPage: vi.fn(),
}));

// Mock database (boundary)
vi.mock('@pagespace/db', () => {
  const selectResult = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  return {
    db: {
      select: vi.fn(() => selectResult),
      insert: vi.fn(() => ({
        values: vi.fn().mockResolvedValue(undefined),
      })),
    },
    chatMessages: {
      pageId: 'pageId',
      isActive: 'isActive',
      createdAt: 'createdAt',
    },
    eq: vi.fn((...args: unknown[]) => args),
    and: vi.fn((...args: unknown[]) => args),
    desc: vi.fn((col: unknown) => col),
  };
});

// Mock loggers (boundary)
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: {
      debug: vi.fn(),
      error: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db';

// Test fixtures
const mockUserId = 'user_123';
const mockPageId = 'page_456';

const mockWebAuth = (userId: string): SessionAuthResult => ({
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

const createGetRequest = (params?: Record<string, string>) => {
  let url = 'https://example.com/api/debug/chat-messages';
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += '?' + searchParams.toString();
  }
  return new Request(url, { method: 'GET' });
};

const createPostRequest = (body: Record<string, unknown>) => {
  return new Request('https://example.com/api/debug/chat-messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

describe('GET /api/debug/chat-messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserViewPage).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('production guard', () => {
    it('should return 404 when NODE_ENV is production', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      const request = createGetRequest({ pageId: mockPageId });
      const response = await GET(request);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Not found');
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createGetRequest({ pageId: mockPageId });
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when pageId is missing', async () => {
      const request = createGetRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('pageId is required for listing messages');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user cannot view the page', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = createGetRequest({ pageId: mockPageId });
      const response = await GET(request);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Forbidden');
    });

    it('should call canUserViewPage with correct userId and pageId', async () => {
      const request = createGetRequest({ pageId: mockPageId });
      await GET(request);

      expect(canUserViewPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });
  });

  describe('successful message retrieval', () => {
    it('should return 200 with messages when authorized', async () => {
      const mockMessages = [
        { id: 'msg_1', role: 'user', content: 'Hello', isActive: true, createdAt: new Date(), userId: mockUserId },
      ];

      const selectResult = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnValue(mockMessages),
        limit: vi.fn().mockResolvedValue([]),
      };
      vi.mocked(db.select).mockReturnValue(selectResult as unknown as ReturnType<typeof db.select>);

      const request = createGetRequest({ pageId: mockPageId });
      const response = await GET(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.pageId).toBe(mockPageId);
    });
  });

  describe('test-db action', () => {
    it('should return 200 for test-db without pageId', async () => {
      const request = createGetRequest({ action: 'test-db' });
      const response = await GET(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.message).toBe('Database connectivity test passed');
    });
  });
});

describe('POST /api/debug/chat-messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default: insert succeeds, select returns empty
    const selectResult = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnValue([]),
      limit: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(selectResult as unknown as ReturnType<typeof db.select>);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof db.insert>);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('production guard', () => {
    it('should return 404 when NODE_ENV is production', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      const request = createPostRequest({ pageId: mockPageId });
      const response = await POST(request);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Not found');
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createPostRequest({ pageId: mockPageId });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when pageId is missing', async () => {
      const request = createPostRequest({});
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('pageId is required');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user cannot edit the page', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const request = createPostRequest({ pageId: mockPageId });
      const response = await POST(request);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Forbidden');
    });

    it('should call canUserEditPage with correct userId and pageId', async () => {
      const request = createPostRequest({ pageId: mockPageId });
      await POST(request);

      expect(canUserEditPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });
  });

  describe('successful insert', () => {
    it('should return 200 on successful insert when authorized', async () => {
      const request = createPostRequest({ pageId: mockPageId });
      const response = await POST(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.message).toBe('Manual save test completed');
    });
  });
});
