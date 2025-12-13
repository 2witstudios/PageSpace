import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock @/lib/auth
const { mockAuthenticateRequest, mockIsAuthError } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mockAuthenticateRequest,
  isAuthError: mockIsAuthError,
}));

// Mock @pagespace/db
const { mockDbInsertReturning, mockDbQueryFindMany } = vi.hoisted(() => ({
  mockDbInsertReturning: vi.fn(),
  mockDbQueryFindMany: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: mockDbInsertReturning,
      })),
    })),
    query: {
      mcpTokens: {
        findMany: mockDbQueryFindMany,
      },
    },
  },
  mcpTokens: {},
}));

// Mock crypto
const { mockRandomBytes } = vi.hoisted(() => ({
  mockRandomBytes: vi.fn(),
}));

vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return {
    ...actual,
    randomBytes: mockRandomBytes,
  };
});

// Mock @pagespace/lib/server
const { mockLoggerError } = vi.hoisted(() => ({
  mockLoggerError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: mockLoggerError,
    },
  },
}));

// Import after mocks
import { POST, GET } from '../route';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock MCP token
const mockMCPToken = (overrides: Partial<{
  id: string;
  name: string;
  token: string;
  createdAt: Date;
  lastUsed: Date | null;
}> = {}) => ({
  id: overrides.id ?? 'token_123',
  name: overrides.name ?? 'My Token',
  token: overrides.token ?? 'mcp_abc123',
  createdAt: overrides.createdAt ?? new Date('2024-01-01'),
  lastUsed: 'lastUsed' in overrides ? overrides.lastUsed : null,
});

// Helper to create POST request
const createPostRequest = (body: Record<string, unknown>, headers?: Record<string, string>) => {
  return new NextRequest('https://example.com/api/auth/mcp-tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
};

// Helper to create GET request
const createGetRequest = () => {
  return new NextRequest('https://example.com/api/auth/mcp-tokens', {
    method: 'GET',
  });
};

describe('MCP Tokens API', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    mockAuthenticateRequest.mockResolvedValue(mockWebAuth('user_123'));
    mockIsAuthError.mockReturnValue(false);

    // Default crypto mock
    mockRandomBytes.mockReturnValue(Buffer.from('abcdefghijklmnopqrstuvwxyz123456'));

    // Default database responses
    mockDbInsertReturning.mockResolvedValue([mockMCPToken()]);
    mockDbQueryFindMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/auth/mcp-tokens', () => {
    describe('Authentication', () => {
      it('should return 401 when not authenticated', async () => {
        mockIsAuthError.mockReturnValue(true);
        mockAuthenticateRequest.mockResolvedValue(mockAuthError(401));

        const request = createPostRequest({ name: 'Test Token' });
        const response = await POST(request);

        expect(response.status).toBe(401);
      });

      it('should require CSRF token', async () => {
        const request = createPostRequest({ name: 'Test Token' });
        await POST(request);

        expect(mockAuthenticateRequest).toHaveBeenCalledWith(
          request,
          { allow: ['jwt'], requireCSRF: true }
        );
      });
    });

    describe('Validation', () => {
      it('should return 400 for missing name', async () => {
        const request = createPostRequest({});
        const response = await POST(request);

        expect(response.status).toBe(400);
      });

      it('should return 400 for empty name', async () => {
        const request = createPostRequest({ name: '' });
        const response = await POST(request);

        expect(response.status).toBe(400);
      });

      it('should return 400 for name exceeding max length', async () => {
        const request = createPostRequest({ name: 'a'.repeat(101) });
        const response = await POST(request);

        expect(response.status).toBe(400);
      });
    });

    describe('Token Generation', () => {
      it('should return 200 with new token', async () => {
        const request = createPostRequest({ name: 'My New Token' });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.id).toBe('token_123');
        expect(body.name).toBe('My Token');
        expect(body.token).toBeDefined();
      });

      it('should generate token with mcp_ prefix', async () => {
        mockDbInsertReturning.mockResolvedValue([mockMCPToken({ token: 'mcp_randombase64token' })]);

        const request = createPostRequest({ name: 'Test Token' });
        const response = await POST(request);
        const body = await response.json();

        expect(body.token).toMatch(/^mcp_/);
      });
    });

    describe('Error Handling', () => {
      it('should return 500 on database error', async () => {
        mockDbInsertReturning.mockRejectedValue(new Error('Database error'));

        const request = createPostRequest({ name: 'Test Token' });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to create MCP token');
      });

      it('should log error on failure', async () => {
        mockDbInsertReturning.mockRejectedValue(new Error('Database error'));

        const request = createPostRequest({ name: 'Test Token' });
        await POST(request);

        expect(mockLoggerError).toHaveBeenCalled();
      });
    });
  });

  describe('GET /api/auth/mcp-tokens', () => {
    describe('Authentication', () => {
      it('should return 401 when not authenticated', async () => {
        mockIsAuthError.mockReturnValue(true);
        mockAuthenticateRequest.mockResolvedValue(mockAuthError(401));

        const request = createGetRequest();
        const response = await GET(request);

        expect(response.status).toBe(401);
      });

      it('should not require CSRF for GET', async () => {
        const request = createGetRequest();
        await GET(request);

        expect(mockAuthenticateRequest).toHaveBeenCalledWith(
          request,
          { allow: ['jwt'], requireCSRF: false }
        );
      });
    });

    describe('Token Listing', () => {
      it('should return empty array when no tokens', async () => {
        mockDbQueryFindMany.mockResolvedValue([]);

        const request = createGetRequest();
        const response = await GET(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual([]);
      });

      it('should return user tokens without token values', async () => {
        mockDbQueryFindMany.mockResolvedValue([
          { id: 'token_1', name: 'Token 1', lastUsed: null, createdAt: new Date('2024-01-01') },
          { id: 'token_2', name: 'Token 2', lastUsed: new Date('2024-01-02'), createdAt: new Date('2024-01-01') },
        ]);

        const request = createGetRequest();
        const response = await GET(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toHaveLength(2);
        expect(body[0]).not.toHaveProperty('token');
        expect(body[0]).toHaveProperty('id');
        expect(body[0]).toHaveProperty('name');
      });
    });

    describe('Error Handling', () => {
      it('should return 500 on database error', async () => {
        mockDbQueryFindMany.mockRejectedValue(new Error('Database error'));

        const request = createGetRequest();
        const response = await GET(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to fetch MCP tokens');
      });
    });
  });
});
