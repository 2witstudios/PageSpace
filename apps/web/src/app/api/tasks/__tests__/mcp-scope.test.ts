/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, MCPAuthResult } from '@/lib/auth';

// ============================================================================
// MCP Drive Scope + App-Member RBAC Enforcement Tests for GET /api/tasks
//
// Verifies that scoped MCP tokens act as their OWN drive member (app RBAC):
// drive universe = the token's memberships, drive access = the token's role,
// task-list visibility = the token's per-page view permission. Session auth
// passes through to user-level checks unchanged.
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
  taskItems: { assigneeId: 'assigneeId', pageId: 'pageId', status: 'status', priority: 'priority', createdAt: 'createdAt', updatedAt: 'updatedAt', description: 'description' },
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

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

const FULL_PERMS = { canView: true, canEdit: true, canShare: true, canDelete: true };

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: any) => 'error' in result),
  checkMCPDriveScope: vi.fn(() => null),
  isScopedMCPAuth: vi.fn((auth: any) => auth.tokenType === 'mcp' && (auth.allowedDriveIds?.length ?? 0) > 0),
  isPrincipalDriveMember: vi.fn(),
  getPrincipalDriveIds: vi.fn(),
  getPrincipalBatchPagePermissions: vi.fn(async (_auth: any, pageIds: string[]) =>
    new Map(pageIds.map((id) => [id, { ...FULL_PERMS }]))),
}));

import {
  authenticateRequestWithOptions,
  checkMCPDriveScope,
  isPrincipalDriveMember,
  getPrincipalDriveIds,
  getPrincipalBatchPagePermissions,
} from '@/lib/auth';
import { db } from '@pagespace/db/db';

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
// MCP Scope + RBAC Enforcement Tests
// ============================================================================

describe('GET /api/tasks - MCP drive scope + app-member RBAC enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPrincipalBatchPagePermissions).mockImplementation(async (_auth: any, pageIds: string[]) =>
      new Map(pageIds.map((id) => [id, { ...FULL_PERMS }])));
  });

  describe('drive context', () => {
    it('should return 403 when the principal (token) is not a member of the drive', async () => {
      const auth = mockMCPAuth(mockUserId, [driveA]);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      // The token has no membership row in driveB — even if the OWNING USER does.
      vi.mocked(isPrincipalDriveMember).mockResolvedValue(false);

      const request = createRequest({ context: 'drive', driveId: driveB });
      const response = await GET(request);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain('do not have access');
      expect(isPrincipalDriveMember).toHaveBeenCalledWith(auth, driveB);
    });

    it('should return 403 when scoped MCP token accesses a drive outside its scope', async () => {
      const auth = mockMCPAuth(mockUserId, [driveA]);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);

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

    it('should proceed when the token is a member and the drive is in scope', async () => {
      const auth = mockMCPAuth(mockUserId, [driveA]);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
      vi.mocked(checkMCPDriveScope).mockReturnValue(null);

      const request = createRequest({ context: 'drive', driveId: driveA });
      const response = await GET(request);

      expect(isPrincipalDriveMember).toHaveBeenCalledWith(auth, driveA);
      expect(response.status).not.toBe(403);
    });

    it('should pass through for session auth (user-level membership)', async () => {
      const auth = mockWebAuth(mockUserId);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
      vi.mocked(checkMCPDriveScope).mockReturnValue(null);

      const request = createRequest({ context: 'drive', driveId: driveA });
      const response = await GET(request);

      expect(isPrincipalDriveMember).toHaveBeenCalledWith(auth, driveA);
      expect(response.status).not.toBe(403);
    });
  });

  describe('user context', () => {
    it('should use the principal drive universe (token memberships for scoped tokens)', async () => {
      const auth = mockMCPAuth(mockUserId, [driveA]);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(getPrincipalDriveIds).mockResolvedValue([driveA]);

      const request = createRequest({ context: 'user' });
      await GET(request);

      expect(getPrincipalDriveIds).toHaveBeenCalledWith(auth);
    });

    it('should return all user drives for session auth in user context', async () => {
      const auth = mockWebAuth(mockUserId);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(getPrincipalDriveIds).mockResolvedValue([driveA, driveB]);

      const request = createRequest({ context: 'user' });
      await GET(request);

      expect(getPrincipalDriveIds).toHaveBeenCalledWith(auth);
    });

    it('should 403 when user context has an explicit driveId outside the principal universe', async () => {
      const auth = mockMCPAuth(mockUserId, [driveA]);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      // Token's drive universe contains only driveA; request filters driveB.
      vi.mocked(getPrincipalDriveIds).mockResolvedValue([driveA]);

      const request = createRequest({ context: 'user', driveId: driveB });
      const response = await GET(request);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain('do not have access');
    });
  });

  describe('task-list visibility (custom-role per-page filtering)', () => {
    it('filters out task lists the scoped token cannot view', async () => {
      const auth = mockMCPAuth(mockUserId, [driveA]);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(getPrincipalDriveIds).mockResolvedValue([driveA]);

      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        { id: 'list_visible', driveId: driveA, title: 'Visible' },
        { id: 'list_hidden', driveId: driveA, title: 'Hidden' },
      ] as any);

      // Custom role grants view on only one of the two task lists.
      vi.mocked(getPrincipalBatchPagePermissions).mockResolvedValue(
        new Map([
          ['list_visible', { ...FULL_PERMS }],
          ['list_hidden', { canView: false, canEdit: false, canShare: false, canDelete: false }],
        ])
      );

      vi.mocked(db.query.taskLists.findMany).mockResolvedValue([] as any);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as any);

      const request = createRequest({ context: 'user' });
      const response = await GET(request);

      expect(getPrincipalBatchPagePermissions).toHaveBeenCalledWith(auth, ['list_visible', 'list_hidden']);
      expect(response.status).toBe(200);
      // taskLists config lookup runs on the FILTERED set — only the visible list.
      expect(db.query.taskLists.findMany).toHaveBeenCalled();
    });

    it('does not run per-page filtering for session auth', async () => {
      const auth = mockWebAuth(mockUserId);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
      vi.mocked(getPrincipalDriveIds).mockResolvedValue([driveA]);
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        { id: 'list_visible', driveId: driveA, title: 'Visible' },
      ] as any);
      vi.mocked(db.query.taskLists.findMany).mockResolvedValue([] as any);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as any);

      const request = createRequest({ context: 'user' });
      await GET(request);

      expect(getPrincipalBatchPagePermissions).not.toHaveBeenCalled();
    });
  });
});
