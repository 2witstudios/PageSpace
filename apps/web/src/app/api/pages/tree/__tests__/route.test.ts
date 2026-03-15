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
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock external boundaries BEFORE imports
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => {
    return result !== null && typeof result === 'object' && 'error' in result;
  }),
  checkMCPDriveScope: vi.fn(() => null),
}));

vi.mock('@pagespace/lib/server', () => ({
  buildTree: vi.fn((pages: unknown[]) => pages),
  loggers: {
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: { findFirst: vi.fn() },
      driveMembers: { findFirst: vi.fn() },
      pages: { findMany: vi.fn() },
    },
  },
  pages: { driveId: 'driveId', isTrashed: 'isTrashed', position: 'position' },
  drives: { id: 'drives.id' },
  driveMembers: { driveId: 'driveMembers.driveId', userId: 'driveMembers.userId' },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => [a, b]),
  asc: vi.fn((col: unknown) => col),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions, checkMCPDriveScope } from '@/lib/auth';
import { buildTree } from '@pagespace/lib/server';
import { db } from '@pagespace/db';

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
      expect(body.error).toBeDefined();
    });

    it('returns 400 when driveId is empty string', async () => {
      const response = await POST(createRequest({ driveId: '' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
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
      expect(body.tree).toBeDefined();
      expect(body.tree[0].id).toBe('page_1');
      expect(buildTree).toHaveBeenCalledWith(mockPages);
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
