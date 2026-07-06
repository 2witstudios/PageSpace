/**
 * Red-team test: a manage-keys-only OAuth credential (Phase 9, mintable today
 * via the manage_keys scope token — see ScopeSet.manageKeys) must be able to
 * reach mcp-tokens (that is exactly what the scope grants), while a
 * drive-scoped OAuth credential must still be rejected exactly as before.
 * Uses the REAL rejectScopedOAuth/isScopedOAuthAuth/isManageKeysOnly
 * implementations (not mocked) so this fails if the carve-out regresses
 * either direction.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { manageKeysScopedAuthResult } from '@/lib/auth/__tests__/manage-keys-fixture';

vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {
    createMcpTokenWithDriveScopes: vi.fn(),
    findDrivesByIds: vi.fn(),
    findUserMcpTokensWithDrives: vi.fn(),
  },
}));

// Only stub authentication — rejectScopedOAuth, isScopedOAuthAuth, and
// isManageKeysOnly run for real.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    authenticateRequestWithOptions: vi.fn(),
  };
});

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
import { authenticateRequestWithOptions } from '@/lib/auth';

const DRIVE_SCOPED_OAUTH = {
  tokenType: 'oauth' as const,
  userId: 'test-user-id',
  role: 'user' as const,
  tokenVersion: 0,
  adminRoleVersion: 0,
  tokenId: 'oauth-token-1',
  scopes: {
    account: false,
    offlineAccess: false,
    manageKeys: false,
    drives: new Map([['drive-1', { kind: 'drive' as const, driveId: 'drive-1', role: { kind: 'inherit' as const } }]]),
  },
  driveScopes: [{ driveId: 'drive-1', role: null, customRoleId: null }],
  allowedDriveIds: ['drive-1'],
};

describe('mcp-tokens routes — manage_keys-only vs drive-scoped OAuth (real isScopedOAuthAuth/isManageKeysOnly)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mockResolvedValue({
      id: 'new-mcp-token-id',
      name: 'Test Token',
      createdAt: new Date(),
    } as never);
    vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([]);
    vi.mocked(sessionRepository.findUserMcpTokensWithDrives).mockResolvedValue([]);
  });

  describe('POST /api/auth/mcp-tokens', () => {
    it('lets a manage_keys-only OAuth credential mint an unscoped mcp token', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Token' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(sessionRepository.createMcpTokenWithDriveScopes).toHaveBeenCalled();
    });

    it('still rejects a drive-scoped OAuth credential, never reaching the repository', async () => {
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
  });

  describe('GET /api/auth/mcp-tokens', () => {
    it('lets a manage_keys-only OAuth credential list mcp tokens', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens', { method: 'GET' });
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(sessionRepository.findUserMcpTokensWithDrives).toHaveBeenCalled();
    });

    it('still rejects a drive-scoped OAuth credential, never reaching the repository', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(DRIVE_SCOPED_OAUTH as never);

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens', { method: 'GET' });
      const response = await GET(request);

      expect(response.status).toBe(403);
      expect(sessionRepository.findUserMcpTokensWithDrives).not.toHaveBeenCalled();
    });
  });
});
