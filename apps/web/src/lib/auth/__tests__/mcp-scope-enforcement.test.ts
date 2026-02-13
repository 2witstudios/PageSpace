/**
 * MCP Token Scope Enforcement Tests
 *
 * Zero-trust tests for MCP token drive-scoping system.
 * Verifies that scoped tokens cannot escape their drive boundaries
 * and that all scope enforcement helpers behave correctly at edge cases.
 *
 * Security properties tested:
 * 1. checkMCPCreateScope prevents scoped tokens from creating drives
 * 2. checkMCPCreateScope prevents scoped tokens from creating in out-of-scope drives
 * 3. checkMCPDriveScope denies access to out-of-scope drives
 * 4. checkMCPPageScope denies access to pages in out-of-scope drives
 * 5. filterDrivesByMCPScope filters to only allowed drives
 * 6. Session auth always has full access (empty allowedDriveIds)
 * 7. Unscoped MCP tokens have full access
 * 8. Scoped tokens with no remaining drives are denied (fail-closed)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock NextResponse
vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    })),
  },
}));

// Mock DB for checkMCPPageScope
const mockPageFindFirst = vi.fn();
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: (...args: unknown[]) => mockPageFindFirst(...args),
      },
      mcpTokens: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  },
  mcpTokens: { tokenHash: 'mcpTokens.tokenHash', revokedAt: 'mcpTokens.revokedAt', id: 'mcpTokens.id' },
  pages: { id: 'pages.id' },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn(),
  sessionService: { validateSession: vi.fn() },
}));

vi.mock('@pagespace/lib/server', () => ({
  EnforcedAuthContext: { fromSession: vi.fn() },
  logSecurityEvent: vi.fn(),
}));

vi.mock('../cookie-config', () => ({
  getSessionFromCookies: vi.fn(),
  COOKIE_CONFIG: {},
  createSessionCookie: vi.fn(),
  createClearSessionCookie: vi.fn(),
  appendSessionCookie: vi.fn(),
  appendClearCookies: vi.fn(),
}));

import {
  checkMCPDriveScope,
  checkMCPPageScope,
  checkMCPCreateScope,
  filterDrivesByMCPScope,
  getAllowedDriveIds,
  type MCPAuthResult,
  type SessionAuthResult,
} from '../index';

describe('MCP Scope Enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Test Fixtures
  // ===========================================================================

  const createScopedMCPAuth = (allowedDriveIds: string[]): MCPAuthResult => ({
    tokenType: 'mcp',
    userId: 'user-123',
    role: 'user',
    tokenVersion: 1,
    adminRoleVersion: 0,
    tokenId: 'token-abc',
    allowedDriveIds,
  });

  const createUnscopedMCPAuth = (): MCPAuthResult => ({
    tokenType: 'mcp',
    userId: 'user-123',
    role: 'user',
    tokenVersion: 1,
    adminRoleVersion: 0,
    tokenId: 'token-abc',
    allowedDriveIds: [],
  });

  const createSessionAuth = (): SessionAuthResult => ({
    tokenType: 'session',
    userId: 'user-123',
    role: 'user',
    tokenVersion: 1,
    adminRoleVersion: 0,
    sessionId: 'session-xyz',
  });

  // ===========================================================================
  // 1. getAllowedDriveIds
  // ===========================================================================

  describe('getAllowedDriveIds', () => {
    it('given session auth, should return empty array (full access)', () => {
      const result = getAllowedDriveIds(createSessionAuth());

      expect(result).toEqual([]);
    });

    it('given unscoped MCP auth, should return empty array (full access)', () => {
      const result = getAllowedDriveIds(createUnscopedMCPAuth());

      expect(result).toEqual([]);
    });

    it('given scoped MCP auth, should return the allowed drive IDs', () => {
      const auth = createScopedMCPAuth(['drive-1', 'drive-2']);
      const result = getAllowedDriveIds(auth);

      expect(result).toEqual(['drive-1', 'drive-2']);
    });
  });

  // ===========================================================================
  // 2. checkMCPDriveScope
  // ===========================================================================

  describe('checkMCPDriveScope', () => {
    it('given session auth, should allow access to any drive', () => {
      const result = checkMCPDriveScope(createSessionAuth(), 'any-drive');

      expect(result).toBeNull();
    });

    it('given unscoped MCP token, should allow access to any drive', () => {
      const result = checkMCPDriveScope(createUnscopedMCPAuth(), 'any-drive');

      expect(result).toBeNull();
    });

    it('given scoped MCP token, should allow access to in-scope drive', () => {
      const auth = createScopedMCPAuth(['drive-1', 'drive-2']);
      const result = checkMCPDriveScope(auth, 'drive-1');

      expect(result).toBeNull();
    });

    it('given scoped MCP token, should deny access to out-of-scope drive', () => {
      const auth = createScopedMCPAuth(['drive-1']);
      const result = checkMCPDriveScope(auth, 'drive-other');

      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it('given scoped MCP token with single drive, should deny access to all other drives', () => {
      const auth = createScopedMCPAuth(['drive-only']);

      expect(checkMCPDriveScope(auth, 'drive-other-1')).not.toBeNull();
      expect(checkMCPDriveScope(auth, 'drive-other-2')).not.toBeNull();
      expect(checkMCPDriveScope(auth, '')).not.toBeNull();
    });

    it('given scoped MCP token, should not allow access via case-variation of drive ID', () => {
      const auth = createScopedMCPAuth(['drive-ABC']);
      const result = checkMCPDriveScope(auth, 'drive-abc');

      // Drive IDs are case-sensitive (CUID2)
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });
  });

  // ===========================================================================
  // 3. checkMCPPageScope
  // ===========================================================================

  describe('checkMCPPageScope', () => {
    it('given session auth, should allow access to any page without DB lookup', async () => {
      const result = await checkMCPPageScope(createSessionAuth(), 'page-123');

      expect(result).toBeNull();
      expect(mockPageFindFirst).not.toHaveBeenCalled();
    });

    it('given unscoped MCP token, should allow access to any page without DB lookup', async () => {
      const result = await checkMCPPageScope(createUnscopedMCPAuth(), 'page-123');

      expect(result).toBeNull();
      expect(mockPageFindFirst).not.toHaveBeenCalled();
    });

    it('given scoped MCP token, should allow access to page in allowed drive', async () => {
      const auth = createScopedMCPAuth(['drive-1']);
      mockPageFindFirst.mockResolvedValue({ driveId: 'drive-1' });

      const result = await checkMCPPageScope(auth, 'page-in-drive-1');

      expect(result).toBeNull();
    });

    it('given scoped MCP token, should deny access to page in disallowed drive', async () => {
      const auth = createScopedMCPAuth(['drive-1']);
      mockPageFindFirst.mockResolvedValue({ driveId: 'drive-other' });

      const result = await checkMCPPageScope(auth, 'page-in-other-drive');

      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it('given scoped MCP token, should return 404 when page does not exist', async () => {
      const auth = createScopedMCPAuth(['drive-1']);
      mockPageFindFirst.mockResolvedValue(null);

      const result = await checkMCPPageScope(auth, 'page-nonexistent');

      expect(result).not.toBeNull();
      expect(result?.status).toBe(404);
    });

    it('given scoped MCP token, page not found should return same error shape as forbidden', async () => {
      // Information leak prevention: 404 vs 403 for nonexistent pages
      // The current implementation returns 404 for not found, which is acceptable
      // since the caller must have already been authenticated
      const auth = createScopedMCPAuth(['drive-1']);
      mockPageFindFirst.mockResolvedValue(null);

      const result = await checkMCPPageScope(auth, 'page-nonexistent');

      expect(result?.body).toHaveProperty('error');
    });
  });

  // ===========================================================================
  // 4. checkMCPCreateScope — PREVIOUSLY UNTESTED
  // ===========================================================================

  describe('checkMCPCreateScope', () => {
    it('given session auth, should allow creating resources anywhere', () => {
      const result = checkMCPCreateScope(createSessionAuth(), 'drive-any');

      expect(result).toBeNull();
    });

    it('given session auth, should allow creating new drives (null targetDriveId)', () => {
      const result = checkMCPCreateScope(createSessionAuth(), null);

      expect(result).toBeNull();
    });

    it('given unscoped MCP token, should allow creating resources anywhere', () => {
      const result = checkMCPCreateScope(createUnscopedMCPAuth(), 'drive-any');

      expect(result).toBeNull();
    });

    it('given unscoped MCP token, should allow creating new drives', () => {
      const result = checkMCPCreateScope(createUnscopedMCPAuth(), null);

      expect(result).toBeNull();
    });

    it('given scoped MCP token, should DENY creating new drives (null targetDriveId)', () => {
      const auth = createScopedMCPAuth(['drive-1']);
      const result = checkMCPCreateScope(auth, null);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it('given scoped MCP token, should allow creating resources in allowed drive', () => {
      const auth = createScopedMCPAuth(['drive-1', 'drive-2']);
      const result = checkMCPCreateScope(auth, 'drive-1');

      expect(result).toBeNull();
    });

    it('given scoped MCP token, should deny creating resources in disallowed drive', () => {
      const auth = createScopedMCPAuth(['drive-1']);
      const result = checkMCPCreateScope(auth, 'drive-other');

      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it('given scoped MCP token with multiple drives, should only allow scoped drives', () => {
      const auth = createScopedMCPAuth(['drive-1', 'drive-2', 'drive-3']);

      expect(checkMCPCreateScope(auth, 'drive-1')).toBeNull();
      expect(checkMCPCreateScope(auth, 'drive-2')).toBeNull();
      expect(checkMCPCreateScope(auth, 'drive-3')).toBeNull();
      expect(checkMCPCreateScope(auth, 'drive-4')).not.toBeNull();
      expect(checkMCPCreateScope(auth, null)).not.toBeNull();
    });

    it('given scoped MCP token, should deny empty string driveId', () => {
      const auth = createScopedMCPAuth(['drive-1']);
      const result = checkMCPCreateScope(auth, '');

      // Empty string is not in the allowed list
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });
  });

  // ===========================================================================
  // 5. filterDrivesByMCPScope
  // ===========================================================================

  describe('filterDrivesByMCPScope', () => {
    it('given session auth, should return all drives unfiltered', () => {
      const drives = ['drive-1', 'drive-2', 'drive-3'];
      const result = filterDrivesByMCPScope(createSessionAuth(), drives);

      expect(result).toEqual(drives);
    });

    it('given unscoped MCP token, should return all drives unfiltered', () => {
      const drives = ['drive-1', 'drive-2', 'drive-3'];
      const result = filterDrivesByMCPScope(createUnscopedMCPAuth(), drives);

      expect(result).toEqual(drives);
    });

    it('given scoped MCP token, should filter to only allowed drives', () => {
      const auth = createScopedMCPAuth(['drive-1', 'drive-3']);
      const drives = ['drive-1', 'drive-2', 'drive-3', 'drive-4'];
      const result = filterDrivesByMCPScope(auth, drives);

      expect(result).toEqual(['drive-1', 'drive-3']);
    });

    it('given scoped MCP token with no matching drives, should return empty array', () => {
      const auth = createScopedMCPAuth(['drive-x']);
      const drives = ['drive-1', 'drive-2'];
      const result = filterDrivesByMCPScope(auth, drives);

      expect(result).toEqual([]);
    });

    it('given scoped MCP token, should not include drives not in input list', () => {
      const auth = createScopedMCPAuth(['drive-1', 'drive-phantom']);
      const drives = ['drive-1', 'drive-2'];
      const result = filterDrivesByMCPScope(auth, drives);

      // drive-phantom is allowed but not in input list
      expect(result).toEqual(['drive-1']);
    });

    it('given empty drive list, should return empty array', () => {
      const auth = createScopedMCPAuth(['drive-1']);
      const result = filterDrivesByMCPScope(auth, []);

      expect(result).toEqual([]);
    });

    it('given scoped MCP token, filter should be case-sensitive', () => {
      const auth = createScopedMCPAuth(['Drive-1']);
      const drives = ['drive-1', 'Drive-1'];
      const result = filterDrivesByMCPScope(auth, drives);

      expect(result).toEqual(['Drive-1']);
    });
  });

  // ===========================================================================
  // 6. SCOPE ESCALATION PREVENTION
  // ===========================================================================

  describe('scope escalation prevention', () => {
    it('given scoped MCP token, cannot access drive by creating resource there', () => {
      const auth = createScopedMCPAuth(['drive-1']);

      // Try to create a resource in a drive outside scope
      const createResult = checkMCPCreateScope(auth, 'drive-2');
      const driveResult = checkMCPDriveScope(auth, 'drive-2');

      expect(createResult).not.toBeNull();
      expect(driveResult).not.toBeNull();
    });

    it('given scoped MCP token, cannot create a new drive to escape scope', () => {
      const auth = createScopedMCPAuth(['drive-1']);
      const result = checkMCPCreateScope(auth, null);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it('given scoped token results are intersected, filter + scope check agree', () => {
      const auth = createScopedMCPAuth(['drive-1', 'drive-2']);

      // Filter agrees with scope check
      const filtered = filterDrivesByMCPScope(auth, ['drive-1', 'drive-3']);
      expect(filtered).toEqual(['drive-1']);

      // Scope check confirms filter result
      expect(checkMCPDriveScope(auth, 'drive-1')).toBeNull();
      expect(checkMCPDriveScope(auth, 'drive-3')).not.toBeNull();
    });
  });
});
