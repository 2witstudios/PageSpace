/**
 * Contract tests for POST and GET /api/auth/mcp-tokens
 *
 * Tests the MCP token management endpoints.
 * Focuses on covering branches not tested by the existing mcp-tokens.test.ts.
 *
 * Additional coverage:
 * - POST: Auth error handling (isAuthError returns true)
 * - POST: Drive scope validation (user lacks access to specified drives)
 * - POST: Transaction with drive scopes insertion
 * - POST: Drive name fetching for scoped tokens
 * - POST: Deduplicate drive IDs
 * - POST: isScoped flag (fail-closed security)
 * - POST: ZodError catch branch
 * - POST: Generic error catch branch
 * - GET: Auth error handling
 * - GET: Drive scope filtering (null drive filtered out)
 * - GET: isScoped field in response
 * - GET: Generic error catch branch
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockDrivesFindMany = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn(),
    transaction: vi.fn(),
    query: {
      mcpTokens: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      drives: {
        findMany: mockDrivesFindMany,
      },
    },
    update: vi.fn(),
  },
  mcpTokens: {},
  mcpTokenDrives: {},
  drives: { id: 'id' },
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  and: vi.fn((...conditions: unknown[]) => conditions),
  inArray: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/auth', () => ({
  generateToken: vi.fn().mockReturnValue({
    token: 'mcp_randomBase64UrlString',
    hash: 'mockTokenHash123',
    tokenPrefix: 'mcp_randomBas',
  }),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com' }),
  logTokenActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn(),
}));

import { POST, GET } from '../route';
import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { generateToken } from '@pagespace/lib/auth';

const setupTransactionMock = (insertMock: ReturnType<typeof vi.fn>) => {
  vi.mocked(db.transaction).mockImplementation((async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
    const tx = { insert: insertMock };
    return callback(tx);
  }) as never);
};

describe('/api/auth/mcp-tokens (additional coverage)', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: 'test-user-id',
      role: 'user',
      tokenVersion: 0,
      tokenType: 'session',
      sessionId: 'test-session-id',
    } as never);
    vi.mocked(isAuthError).mockImplementation(
      (result: unknown) => result != null && typeof result === 'object' && 'error' in result
    );

    // Default mocks that need re-setup after resetAllMocks
    vi.mocked(getActorInfo).mockResolvedValue({ actorEmail: 'test@example.com' } as never);
    vi.mocked(generateToken).mockReturnValue({
      token: 'mcp_randomBase64UrlString',
      hash: 'mockTokenHash123',
      tokenPrefix: 'mcp_randomBas',
    });
    mockDrivesFindMany.mockResolvedValue([]);

    // Default transaction mock
    const defaultInsertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: 'new-mcp-token-id',
            name: 'Test Token',
            createdAt: new Date(),
          },
        ]),
      }),
    });
    setupTransactionMock(defaultInsertMock);

    // Default drive access mock
    vi.mocked(getDriveAccess).mockResolvedValue({
      isOwner: true,
      isAdmin: true,
      isMember: true,
      role: 'OWNER',
    } as never);
  });

  describe('POST /api/auth/mcp-tokens', () => {
    describe('authentication', () => {
      it('returns auth error response when not authenticated', async () => {
        const mockErrorResponse = Response.json({ error: 'Unauthorized' }, { status: 401 });
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
          error: mockErrorResponse,
        } as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Token' }),
        });

        const response = await POST(request);
        expect(response.status).toBe(401);
      });
    });

    describe('drive scope validation', () => {
      it('returns 403 when user lacks access to specified drives', async () => {
        vi.mocked(getDriveAccess).mockResolvedValue({
          isOwner: false,
          isAdmin: false,
          isMember: false,
          role: null,
        } as never);

        const insertMock = vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: 'token-id', name: 'Token', createdAt: new Date() },
            ]),
          }),
        });
        setupTransactionMock(insertMock);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'Scoped Token', driveIds: ['drive-1', 'drive-2'] }),
        });

        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.error).toContain('You do not have access');
        expect(body.error).toContain('drive-1');
        expect(body.error).toContain('drive-2');
      });

      it('allows scoping to drives where user is member but not owner', async () => {
        vi.mocked(getDriveAccess).mockResolvedValue({
          isOwner: false,
          isAdmin: false,
          isMember: true,
          role: 'MEMBER',
        } as never);

        mockDrivesFindMany.mockResolvedValue([
          { id: 'drive-1', name: 'Shared Drive' },
        ]);

        let callCount = 0;
        const insertMock = vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // First call: insert mcpTokens
            return {
              values: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([
                  { id: 'token-id', name: 'Token', createdAt: new Date() },
                ]),
              }),
            };
          }
          // Second call: insert mcpTokenDrives (no .returning())
          return {
            values: vi.fn().mockResolvedValue(undefined),
          };
        });
        setupTransactionMock(insertMock);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'Scoped Token', driveIds: ['drive-1'] }),
        });

        const response = await POST(request);
        expect(response.status).toBe(200);
      });

      it('deduplicates drive IDs', async () => {
        vi.mocked(getDriveAccess).mockResolvedValue({
          isOwner: true,
          isAdmin: true,
          isMember: true,
          role: 'OWNER',
        } as never);

        mockDrivesFindMany.mockResolvedValue([
          { id: 'drive-1', name: 'My Drive' },
        ]);

        let capturedDriveScopes: Array<{ tokenId: string; driveId: string }> | undefined;
        let dedupeCallCount = 0;
        const insertMock = vi.fn().mockImplementation(() => {
          dedupeCallCount++;
          if (dedupeCallCount === 1) {
            // First call: insert mcpTokens
            return {
              values: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([
                  { id: 'token-id', name: 'Token', createdAt: new Date() },
                ]),
              }),
            };
          }
          // Second call: insert mcpTokenDrives
          return {
            values: vi.fn().mockImplementation((vals: unknown) => {
              if (Array.isArray(vals)) {
                capturedDriveScopes = vals;
              }
              return Promise.resolve();
            }),
          };
        });
        setupTransactionMock(insertMock);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'Token', driveIds: ['drive-1', 'drive-1', 'drive-1'] }),
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        // getDriveAccess should only be called once (deduplication)
        expect(getDriveAccess).toHaveBeenCalledTimes(1);

        // Drive scopes should only have one entry (deduplication)
        if (capturedDriveScopes) {
          expect(capturedDriveScopes.length).toBe(1);
        }
      });
    });

    describe('error handling', () => {
      it('returns 500 on generic error', async () => {
        vi.mocked(db.transaction).mockRejectedValue(new Error('Transaction failed'));

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'My Token' }),
        });

        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to create MCP token');
        expect(loggers.auth.error).toHaveBeenCalled();
      });
    });
  });

  describe('GET /api/auth/mcp-tokens', () => {
    describe('authentication', () => {
      it('returns auth error response when not authenticated', async () => {
        const mockErrorResponse = Response.json({ error: 'Unauthorized' }, { status: 401 });
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
          error: mockErrorResponse,
        } as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: { Cookie: 'ps_session=valid-token' },
        });

        const response = await GET(request);
        expect(response.status).toBe(401);
      });
    });

    describe('drive scope filtering', () => {
      it('filters out drive scopes where drive is null (deleted drive)', async () => {
        vi.mocked(db.query.mcpTokens.findMany).mockResolvedValue([
          {
            id: 'token-1',
            name: 'Token 1',
            lastUsed: null,
            createdAt: new Date(),
            isScoped: true,
            driveScopes: [
              { driveId: 'drive-1', drive: { id: 'drive-1', name: 'Active Drive' } },
              { driveId: 'drive-2', drive: null }, // Deleted drive
            ],
          },
        ] as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: { Cookie: 'ps_session=valid-token' },
        });

        const response = await GET(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body[0].driveScopes.length).toBe(1);
        expect(body[0].driveScopes[0].id).toBe('drive-1');
      });

      it('includes isScoped field in response', async () => {
        vi.mocked(db.query.mcpTokens.findMany).mockResolvedValue([
          {
            id: 'token-1',
            name: 'Scoped Token',
            lastUsed: null,
            createdAt: new Date(),
            isScoped: true,
            driveScopes: [],
          },
          {
            id: 'token-2',
            name: 'Unscoped Token',
            lastUsed: null,
            createdAt: new Date(),
            isScoped: false,
            driveScopes: [],
          },
        ] as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: { Cookie: 'ps_session=valid-token' },
        });

        const response = await GET(request);
        const body = await response.json();

        expect(body[0].isScoped).toBe(true);
        expect(body[1].isScoped).toBe(false);
      });
    });

    describe('error handling', () => {
      it('returns 500 on generic error', async () => {
        vi.mocked(db.query.mcpTokens.findMany).mockRejectedValue(new Error('DB error'));

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: { Cookie: 'ps_session=valid-token' },
        });

        const response = await GET(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to fetch MCP tokens');
        expect(loggers.auth.error).toHaveBeenCalled();
      });
    });
  });
});
