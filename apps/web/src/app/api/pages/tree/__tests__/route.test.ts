/**
 * Contract tests for POST /api/pages/tree
 *
 * Tests verify:
 * - Authentication via authenticateRequestWithOptions
 * - Zod validation of request body (driveId required)
 * - MCP drive scope checking
 * - Drive existence check (404 if missing)
 * - Authorization: owner or member access
 * - Page tree building via buildTree
 * - Error handling (500 on db/JSON failure)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
// Mock external boundaries BEFORE imports
vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((result: unknown) => {
    return result !== null && typeof result === 'object' && 'error' in result;
  }),
  checkMCPDriveScope: vi.fn(() => null),
}));
vi.mock('@/lib/auth/principal-permissions', () => ({
  isScopedMCPAuth: vi.fn(() => false),
  getPrincipalAccessiblePagesInDrive: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppDriveAccessLevel: vi.fn(),
}));

vi.mock('@pagespace/lib/content/tree-utils', () => ({
    buildTree: vi.fn((pages: unknown[]) => pages),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      drives: { findFirst: vi.fn() },
      driveMembers: { findFirst: vi.fn() },
      pages: { findMany: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => [a, b]),
  asc: vi.fn((col: unknown) => col),
  isNotNull: vi.fn((a: unknown) => ({ _isNotNull: true, col: a })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { driveId: 'driveId', isTrashed: 'isTrashed', position: 'position' },
  drives: { id: 'drives.id' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { driveId: 'driveMembers.driveId', userId: 'driveMembers.userId', acceptedAt: 'driveMembers.acceptedAt' },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserAccessiblePagesInDrive: vi.fn(),
}));

import { POST } from '../route';
import { buildTree } from '@pagespace/lib/content/tree-utils';
import { db } from '@pagespace/db/db';
import { getUserAccessiblePagesInDrive } from '@pagespace/lib/permissions/permissions';
import type { SessionAuthResult, AuthError } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { checkMCPDriveScope } from '@/lib/auth/auth-core';

// Test helpers
const mockUserId = 'user_123';
const mockDriveId = 'drive_abc';

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

const createRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/pages/tree', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/pages/tree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);
    // @ts-expect-error - partial mock data
    vi.mocked(db.query.drives.findFirst).mockResolvedValue({
      id: mockDriveId,
      ownerId: mockUserId,
    });
    vi.mocked(db.query.pages.findMany).mockResolvedValue([
      // @ts-expect-error - partial mock data
      { id: 'page_1', parentId: null, position: 0 },
    ]);
    vi.mocked(buildTree).mockReturnValue([{ id: 'page_1', children: [] }] as never);
    // Default: all pages accessible (used for non-owner path)
    vi.mocked(getUserAccessiblePagesInDrive).mockResolvedValue(['page_1']);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest({ driveId: mockDriveId }));

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('returns 400 when driveId is missing', async () => {
      const response = await POST(createRequest({}));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid input: expected string, received undefined');
    });

    it('returns 400 when driveId is empty string', async () => {
      const response = await POST(createRequest({ driveId: '' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Drive ID is required');
    });
  });

  describe('MCP scope check', () => {
    it('returns scope error when MCP token lacks drive access', async () => {
      vi.mocked(checkMCPDriveScope).mockReturnValue(
        NextResponse.json({ error: 'Token not scoped for this drive' }, { status: 403 })
      );

      const response = await POST(createRequest({ driveId: mockDriveId }));

      expect(response.status).toBe(403);
    });
  });

  describe('drive existence and authorization', () => {
    it('returns 404 when drive does not exist', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

      const response = await POST(createRequest({ driveId: mockDriveId }));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });

    it('allows access when user is drive owner', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({
        id: mockDriveId,
        ownerId: mockUserId,
      });

      const response = await POST(createRequest({ driveId: mockDriveId }));

      expect(response.status).toBe(200);
      // Should NOT check membership when user is owner
      expect(db.query.driveMembers.findFirst).not.toHaveBeenCalled();
    });

    it('allows access when user is drive member (not owner)', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({
        id: mockDriveId,
        ownerId: 'other_user',
      });
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({
        driveId: mockDriveId,
        userId: mockUserId,
      });

      const response = await POST(createRequest({ driveId: mockDriveId }));

      expect(response.status).toBe(200);
    });

    it('returns 403 when user is neither owner nor member', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({
        id: mockDriveId,
        ownerId: 'other_user',
      });
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined);

      const response = await POST(createRequest({ driveId: mockDriveId }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/access denied/i);
    });

    // Review C2 — pending member can read full page tree of a drive they have
    // not joined. The tree leaks every non-trashed page (id, title, type,
    // parentId, position, isTrashed). Adversarial pin against that path.
    it('rejects pending member (acceptedAt IS NULL) — adversarial pending-member-reads-page-tree path', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({
        id: mockDriveId,
        ownerId: 'other_user',
      });
      // Post-fix the gate filters this row out and findFirst returns undefined.
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined);

      const response = await POST(createRequest({ driveId: mockDriveId }));

      expect(response.status).toBe(403);
      const { isNotNull } = await import('@pagespace/db/operators');
      expect(isNotNull).toHaveBeenCalledWith('driveMembers.acceptedAt');
    });
  });

  describe('tree building', () => {
    it('returns page tree on success', async () => {
      const mockPages = [
        { id: 'page_1', parentId: null, position: 0 },
        { id: 'page_2', parentId: 'page_1', position: 0 },
      ];
      vi.mocked(db.query.pages.findMany).mockResolvedValue(mockPages as never);
      vi.mocked(buildTree).mockReturnValue([
        // @ts-expect-error - partial mock data
        { id: 'page_1', children: [{ id: 'page_2', children: [] }] },
      ]);

      const response = await POST(createRequest({ driveId: mockDriveId }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tree).toEqual([
        { id: 'page_1', children: [{ id: 'page_2', children: [] }] },
      ]);
      expect(body.tree[0].id).toBe('page_1');
      expect(buildTree).toHaveBeenCalledWith(mockPages);
    });

    it('does not call getUserAccessiblePagesInDrive for the drive owner', async () => {
      // owner set in beforeEach (ownerId: mockUserId)
      await POST(createRequest({ driveId: mockDriveId }));

      expect(getUserAccessiblePagesInDrive).not.toHaveBeenCalled();
    });
  });

  describe('private page filtering', () => {
    const otherOwnerId = 'other_owner';

    beforeEach(() => {
      // Switch to non-owner so filtering kicks in
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({
        id: mockDriveId,
        ownerId: otherOwnerId,
      });
      // @ts-expect-error - partial mock data
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({
        driveId: mockDriveId,
        userId: mockUserId,
      });
    });

    it('filters out pages not in the accessible set for non-owners', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        { id: 'public_page', parentId: null, position: 0 },
        { id: 'private_page', parentId: null, position: 1 },
      ] as never);
      // Only public_page is accessible to this member
      vi.mocked(getUserAccessiblePagesInDrive).mockResolvedValue(['public_page']);

      await POST(createRequest({ driveId: mockDriveId }));

      // buildTree should only receive the accessible page
      expect(buildTree).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'public_page' })])
      );
      const callArg = vi.mocked(buildTree).mock.calls[0][0] as { id: string }[];
      expect(callArg.some(p => p.id === 'private_page')).toBe(false);
    });

    it('calls getUserAccessiblePagesInDrive with correct userId and driveId for non-owners', async () => {
      vi.mocked(getUserAccessiblePagesInDrive).mockResolvedValue(['page_1']);

      await POST(createRequest({ driveId: mockDriveId }));

      expect(getUserAccessiblePagesInDrive).toHaveBeenCalledWith(mockUserId, mockDriveId);
    });

    it('shows all pages when all are in the accessible set', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        { id: 'page_a', parentId: null, position: 0 },
        { id: 'page_b', parentId: null, position: 1 },
      ] as never);
      vi.mocked(getUserAccessiblePagesInDrive).mockResolvedValue(['page_a', 'page_b']);

      await POST(createRequest({ driveId: mockDriveId }));

      const callArg = vi.mocked(buildTree).mock.calls[0][0] as { id: string }[];
      expect(callArg).toHaveLength(2);
    });
  });

  describe('error handling', () => {
    it('returns 500 when database query throws', async () => {
      vi.mocked(db.query.drives.findFirst).mockRejectedValueOnce(new Error('DB error'));

      const response = await POST(createRequest({ driveId: mockDriveId }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });

    it('returns 500 when request.json() throws (invalid JSON)', async () => {
      const badRequest = new Request('https://example.com/api/pages/tree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      });

      const response = await POST(badRequest);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});
