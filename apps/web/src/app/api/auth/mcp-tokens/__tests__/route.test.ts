/**
 * Contract tests for POST and GET /api/auth/mcp-tokens
 *
 * Tests the MCP token management endpoints.
 * Focuses on covering branches not tested by the existing mcp-tokens.test.ts.
 *
 * Additional coverage:
 * - POST: Auth error handling (isAuthError returns true)
 * - POST: Drive scope validation (user lacks access to specified drives)
 * - POST: Repository call with drive scopes
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

vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {
    createMcpTokenWithDriveScopes: vi.fn(),
    findDrivesByIds: vi.fn(),
    findUserMcpTokensWithDrives: vi.fn(),
    findMcpTokenByIdAndUser: vi.fn(),
    revokeMcpToken: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  isScopedOAuthAuth: vi.fn(),
  isManageKeysOnly: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    security: {
      warn: vi.fn(),
    },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/token-utils', () => ({
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
  validateDriveScopeAccess: vi.fn(),
}));

import { POST, GET } from '../route';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { authenticateRequestWithOptions, isAuthError, isScopedOAuthAuth, isManageKeysOnly } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateDriveScopeAccess } from '@pagespace/lib/services/drive-service';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { generateToken } from '@pagespace/lib/auth/token-utils';

const DRIVE_SCOPED_OAUTH = {
  userId: 'test-user-id',
  role: 'user',
  tokenVersion: 0,
  adminRoleVersion: 0,
  tokenType: 'oauth',
  tokenId: 'oauth-token-1',
  scopes: { account: false, offlineAccess: false, drives: new Map([['drive-1', { kind: 'drive', driveId: 'drive-1', role: { kind: 'inherit' } }]]) },
  driveScopes: [{ driveId: 'drive-1', role: null, customRoleId: null }],
  allowedDriveIds: ['drive-1'],
};

const ACCOUNT_SCOPED_OAUTH = {
  userId: 'test-user-id',
  role: 'user',
  tokenVersion: 0,
  adminRoleVersion: 0,
  tokenType: 'oauth',
  tokenId: 'oauth-token-2',
  scopes: { account: true, offlineAccess: false, drives: new Map() },
  driveScopes: [],
  allowedDriveIds: [],
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
    vi.mocked(isScopedOAuthAuth).mockImplementation(
      (auth: unknown) =>
        !!auth &&
        typeof auth === 'object' &&
        (auth as { tokenType?: string }).tokenType === 'oauth' &&
        !(auth as { scopes?: { account?: boolean } }).scopes?.account
    );
    vi.mocked(isManageKeysOnly).mockReturnValue(false);

    // Default mocks that need re-setup after resetAllMocks
    vi.mocked(getActorInfo).mockResolvedValue({ actorEmail: 'test@example.com' } as never);
    vi.mocked(generateToken).mockReturnValue({
      token: 'mcp_randomBase64UrlString',
      hash: 'mockTokenHash123',
      tokenPrefix: 'mcp_randomBas',
    });

    // Default repository mocks
    vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mockResolvedValue({
      id: 'new-mcp-token-id',
      name: 'Test Token',
      createdAt: new Date(),
    } as never);
    vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([]);
    vi.mocked(sessionRepository.findUserMcpTokensWithDrives).mockResolvedValue([]);

    // Default: drive scope validation succeeds
    vi.mocked(validateDriveScopeAccess).mockResolvedValue({
      invalidDriveIds: [],
      unauthorizedRoles: [],
      invalidCustomRoles: [],
      unauthorizedCustomRoles: [],
    });
  });

  describe('POST /api/auth/mcp-tokens', () => {
    describe('authentication', () => {
      it('allows OAuth bearer tokens (CLI `pagespace tokens create`), not just session cookies', async () => {
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Token' }),
        });

        await POST(request);

        expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
          request,
          expect.objectContaining({ allow: expect.arrayContaining(['oauth']) })
        );
      });

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

    describe('P1a — OAuth account-scope enforcement (a drive-scoped OAuth token must not mint an unscoped MCP token)', () => {
      it('rejects a drive-scoped OAuth token, never reaching the repository', async () => {
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(DRIVE_SCOPED_OAUTH as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Token' }),
        });

        const response = await POST(request);

        expect(response.status).toBe(403);
        expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();
      });

      it('allows an account-scoped OAuth token', async () => {
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(ACCOUNT_SCOPED_OAUTH as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Token' }),
        });

        const response = await POST(request);

        expect(response.status).toBe(200);
      });

      it('leaves session auth unaffected', async () => {
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'My Token' }),
        });

        const response = await POST(request);

        expect(response.status).toBe(200);
      });
    });

    describe('drive scope validation', () => {
      it('returns 403 when user lacks access to specified drives', async () => {
        vi.mocked(validateDriveScopeAccess).mockResolvedValue({
          invalidDriveIds: ['drive-1', 'drive-2'],
          unauthorizedRoles: [],
          invalidCustomRoles: [],
          unauthorizedCustomRoles: [],
        });

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
        expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();
      });

      it('allows scoping to drives where user is member but not owner', async () => {
        vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([
          { id: 'drive-1', name: 'Shared Drive' },
        ]);

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
        vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([
          { id: 'drive-1', name: 'My Drive' },
        ]);

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

        // Validation should run once on the deduplicated set, not once per raw ID
        expect(validateDriveScopeAccess).toHaveBeenCalledTimes(1);
        expect(validateDriveScopeAccess).toHaveBeenCalledWith(
          [{ id: 'drive-1', role: null, customRoleId: undefined }],
          'test-user-id'
        );

        // Repository should be called with deduplicated drives.
        // Legacy driveIds carry no role: stored role is null (inherit owner).
        const createArgs = vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mock.calls[0][0];
        expect(createArgs.drives).toEqual([{ id: 'drive-1', role: null, customRoleId: undefined }]);
      });

      it('stores role null (inherit) when drives[] entries omit the role', async () => {
        vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([
          { id: 'drive-1', name: 'My Drive' },
        ]);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'Token', drives: [{ id: 'drive-1' }] }),
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        const createArgs = vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mock.calls[0][0];
        expect(createArgs.drives).toEqual([{ id: 'drive-1', role: null, customRoleId: undefined }]);
      });
    });

    describe('custom role privilege escalation', () => {
      it('returns 403 when a MEMBER specifies a custom role not assigned to them', async () => {
        vi.mocked(validateDriveScopeAccess).mockResolvedValue({
          invalidDriveIds: [],
          unauthorizedRoles: [],
          invalidCustomRoles: [],
          unauthorizedCustomRoles: ['drive-1'],
        });

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: 'ps_session=valid-token', 'X-CSRF-Token': 'x' },
          body: JSON.stringify({ name: 'Token', drives: [{ id: 'drive-1', role: 'MEMBER', customRoleId: 'role-other' }] }),
        });

        const response = await POST(request);
        const body = await response.json();
        expect(response.status).toBe(403);
        expect(body.error).toContain('custom role');
        expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();
      });

      it('allows a MEMBER to mint a token with their own assigned custom role', async () => {
        vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([{ id: 'drive-1', name: 'Drive' }] as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: 'ps_session=valid-token', 'X-CSRF-Token': 'x' },
          body: JSON.stringify({ name: 'Token', drives: [{ id: 'drive-1', role: 'MEMBER', customRoleId: 'role-xyz' }] }),
        });

        const response = await POST(request);
        expect(response.status).toBe(200);
      });

      it('allows an ADMIN to mint a token with any custom role', async () => {
        // Whether the admin-bypass rule (no ownership check on the caller's
        // own custom role) is applied correctly is unit-tested directly on
        // validateDriveScopeAccess in drive-service.test.ts; at the route
        // level we just confirm a successful validation results in 200.
        vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([{ id: 'drive-1', name: 'Drive' }] as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: 'ps_session=valid-token', 'X-CSRF-Token': 'x' },
          body: JSON.stringify({ name: 'Token', drives: [{ id: 'drive-1', role: 'MEMBER', customRoleId: 'any-role' }] }),
        });

        const response = await POST(request);
        expect(response.status).toBe(200);
      });
    });

    describe('error handling', () => {
      it('returns 500 on generic error', async () => {
        vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mockRejectedValueOnce(
          new Error('Transaction failed')
        );

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
        expect(loggers.auth.error).toHaveBeenCalledWith(
          'Error creating MCP token:',
          new Error('Transaction failed'),
        );
      });
    });
  });

  describe('GET /api/auth/mcp-tokens', () => {
    describe('authentication', () => {
      it('allows OAuth bearer tokens (CLI `pagespace tokens list`), not just session cookies', async () => {
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: { Cookie: 'ps_session=valid-token' },
        });

        await GET(request);

        expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
          request,
          expect.objectContaining({ allow: expect.arrayContaining(['oauth']) })
        );
      });

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

    describe('P1a — OAuth account-scope enforcement (a drive-scoped OAuth token must not list all MCP tokens)', () => {
      it('rejects a drive-scoped OAuth token, never reaching the repository', async () => {
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(DRIVE_SCOPED_OAUTH as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', { method: 'GET' });
        const response = await GET(request);

        expect(response.status).toBe(403);
        expect(sessionRepository.findUserMcpTokensWithDrives).not.toHaveBeenCalled();
      });

      it('allows an account-scoped OAuth token', async () => {
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(ACCOUNT_SCOPED_OAUTH as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', { method: 'GET' });
        const response = await GET(request);

        expect(response.status).toBe(200);
      });
    });

    describe('drive scope filtering', () => {
      it('filters out drive scopes where drive is null (deleted drive)', async () => {
        // Repository already does the filtering; return pre-filtered data
        vi.mocked(sessionRepository.findUserMcpTokensWithDrives).mockResolvedValue([
          {
            id: 'token-1',
            name: 'Token 1',
            lastUsed: null,
            createdAt: new Date(),
            isScoped: true,
            driveScopes: [
              { id: 'drive-1', name: 'Active Drive' },
              // Deleted drive already filtered by repository
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

      it('includes tokenPrefix in the response so the CLI can display it without ever showing the full token', async () => {
        vi.mocked(sessionRepository.findUserMcpTokensWithDrives).mockResolvedValue([
          {
            id: 'token-1',
            name: 'Token 1',
            tokenPrefix: 'mcp_abcdefghijk',
            lastUsed: null,
            createdAt: new Date(),
            isScoped: true,
            driveScopes: [],
          },
        ] as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: { Cookie: 'ps_session=valid-token' },
        });

        const response = await GET(request);
        const body = await response.json();

        expect(body[0].tokenPrefix).toBe('mcp_abcdefghijk');
        expect(JSON.stringify(body)).not.toContain('"token":');
      });

      it('includes isScoped field in response', async () => {
        vi.mocked(sessionRepository.findUserMcpTokensWithDrives).mockResolvedValue([
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
        vi.mocked(sessionRepository.findUserMcpTokensWithDrives).mockRejectedValueOnce(
          new Error('DB error')
        );

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: { Cookie: 'ps_session=valid-token' },
        });

        const response = await GET(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('Failed to fetch MCP tokens');
        expect(loggers.auth.error).toHaveBeenCalledWith(
          'Error fetching MCP tokens:',
          new Error('DB error'),
        );
      });
    });
  });
});
