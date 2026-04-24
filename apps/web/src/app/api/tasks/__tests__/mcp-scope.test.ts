/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, MCPAuthResult } from '@/lib/auth';

// ============================================================================
// MCP Drive Scope Enforcement Tests for GET /api/tasks
//
// Verifies that scoped MCP tokens cannot access tasks outside their
// allowed drives. Session auth should pass through unchanged.
// ============================================================================

// Mock dependencies
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findMany: vi.fn() },
      taskLists: { findMany: vi.fn() },
      taskItems: { findMany: vi.fn() },
      taskStatusConfigs: { findMany: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn((...args: any[]) => args),
  desc: vi.fn(),
  count: vi.fn(),
  gte: vi.fn(),
  lt: vi.fn(),
  lte: vi.fn(),
  inArray: vi.fn(),
  or: vi.fn(),
  isNull: vi.fn(),
  not: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', type: 'type', isTrashed: 'isTrashed', title: 'title' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { taskListId: 'taskListId', assigneeId: 'assigneeId', pageId: 'pageId', status: 'status', priority: 'priority', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  taskLists: { id: 'id', pageId: 'pageId' },
  taskStatusConfigs: { taskListId: 'taskListId' },
}));

vi.mock('@/lib/task-status-config', () => ({
  DEFAULT_STATUS_CONFIG: {} as Record<string, { label: string; color: string; group: string }>,
}));

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

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: vi.fn(),
  getDriveIdsForUser: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: any) => 'error' in result),
  checkMCPDriveScope: vi.fn(() => null),
  filterDrivesByMCPScope: vi.fn((_auth: any, driveIds: string[]) => driveIds),
}));

import { authenticateRequestWithOptions, checkMCPDriveScope, filterDrivesByMCPScope } from '@/lib/auth';
import { isUserDriveMember, getDriveIdsForUser } from '@pagespace/lib/permissions/permissions';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockUserId = 'user_123';
const driveA = 'drive_A';
const driveB = 'drive_B';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockMCPAuth = (userId: string, allowedDriveIds: string[]): MCPAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'mcp',
  tokenId: 'mcp-token-id',
  role: 'user',
  adminRoleVersion: 0,
  allowedDriveIds,
});

const createRequest = (params: Record<string, string> = {}) => {
  const url = new URL('https://example.com/api/tasks');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString(), { method: 'GET' });
};

// ============================================================================
// MCP Scope Enforcement Tests
// ============================================================================

describe('GET /api/tasks - MCP drive scope enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('drive context', () => {
    it('should return 403 when scoped MCP token accesses a drive outside its scope', async () => {
      const auth = mockMCPAuth(mockUserId, [driveA]);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(isUserDriveMember).mockResolvedValue(true);

      // Simulate checkMCPDriveScope returning 403 for out-of-scope drive
      vi.mocked(checkMCPDriveScope).mockReturnValue(
        NextResponse.json(
          { error: 'This token does not have access to this drive' },
          { status: 403 }
        )
      );

      const request = createRequest({ context: 'drive', driveId: driveB });
      const response = await GET(request);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain('token does not have access');
      expect(checkMCPDriveScope).toHaveBeenCalledWith(auth, driveB);
    });

    it('should proceed when scoped MCP token accesses a drive within its scope', async () => {
      const auth = mockMCPAuth(mockUserId, [driveA]);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(isUserDriveMember).mockResolvedValue(true);
      vi.mocked(checkMCPDriveScope).mockReturnValue(null);

      const request = createRequest({ context: 'drive', driveId: driveA });
      const response = await GET(request);

      // Scope check was called and passed (returned null)
      expect(checkMCPDriveScope).toHaveBeenCalledWith(auth, driveA);
      // Route proceeds past scope check - should NOT be a 403 scope denial
      expect(response.status).not.toBe(403);
    });

    it('should pass through for session auth without scope filtering', async () => {
      const auth = mockWebAuth(mockUserId);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(isUserDriveMember).mockResolvedValue(true);
      vi.mocked(checkMCPDriveScope).mockReturnValue(null);

      const request = createRequest({ context: 'drive', driveId: driveA });
      const response = await GET(request);

      expect(checkMCPDriveScope).toHaveBeenCalledWith(auth, driveA);
      // Session auth always passes scope check - should NOT be a 403 scope denial
      expect(response.status).not.toBe(403);
    });
  });

  describe('user context', () => {
    it('should filter drives by MCP scope in user context', async () => {
      const auth = mockMCPAuth(mockUserId, [driveA]);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(getDriveIdsForUser).mockResolvedValue([driveA, driveB]);

      // filterDrivesByMCPScope should restrict to only driveA
      vi.mocked(filterDrivesByMCPScope).mockReturnValue([driveA]);

      const request = createRequest({ context: 'user' });
      await GET(request);

      expect(filterDrivesByMCPScope).toHaveBeenCalledWith(auth, [driveA, driveB]);
    });

    it('should return all drives for session auth in user context', async () => {
      const auth = mockWebAuth(mockUserId);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(getDriveIdsForUser).mockResolvedValue([driveA, driveB]);

      // Session auth: filterDrivesByMCPScope returns all drives
      vi.mocked(filterDrivesByMCPScope).mockReturnValue([driveA, driveB]);

      const request = createRequest({ context: 'user' });
      await GET(request);

      expect(filterDrivesByMCPScope).toHaveBeenCalledWith(auth, [driveA, driveB]);
    });

    it('should enforce scope check when user context has explicit driveId filter', async () => {
      const auth = mockMCPAuth(mockUserId, [driveA]);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(getDriveIdsForUser).mockResolvedValue([driveA, driveB]);

      // First call is for the user-context driveIds, second for the explicit driveId check
      vi.mocked(filterDrivesByMCPScope).mockReturnValue([driveA, driveB]);

      // The explicit driveId check - scoped token trying to access driveB
      vi.mocked(checkMCPDriveScope).mockReturnValue(
        NextResponse.json(
          { error: 'This token does not have access to this drive' },
          { status: 403 }
        )
      );

      const request = createRequest({ context: 'user', driveId: driveB });
      const response = await GET(request);

      expect(response.status).toBe(403);
      expect(checkMCPDriveScope).toHaveBeenCalledWith(auth, driveB);
    });
  });
});
