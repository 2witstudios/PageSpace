import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/trash
//
// Tests mock at the SERVICE SEAM level, not ORM level.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
  pages: { driveId: 'pages.driveId', isTrashed: 'pages.isTrashed' },
  driveMembers: { driveId: 'driveMembers.driveId', userId: 'driveMembers.userId', role: 'driveMembers.role' },
  db: {
    query: {
      drives: {
        findFirst: vi.fn(),
      },
      pages: {
        findMany: vi.fn(),
      },
    },
    select: vi.fn(),
  },
  eq: vi.fn((a, b) => ({ field: a, value: b })),
  and: vi.fn((...args: unknown[]) => args),
  asc: vi.fn((col) => ({ column: col, direction: 'asc' })),
}));

vi.mock('@pagespace/lib/server', () => ({
  buildTree: vi.fn(),
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
}));

import { GET } from '../route';
import { db } from '@pagespace/db';
import { buildTree, loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

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

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

const createDriveFixture = (overrides: { id: string; name?: string; ownerId?: string }) => ({
  id: overrides.id,
  name: overrides.name ?? 'Test Drive',
  slug: 'test-drive',
  ownerId: overrides.ownerId ?? 'user_123',
  isTrashed: false,
  trashedAt: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  drivePrompt: null,
});

// ============================================================================
// GET /api/drives/[driveId]/trash - Contract Tests
// ============================================================================

describe('GET /api/drives/[driveId]/trash', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockFromFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);
    vi.mocked(buildTree).mockReturnValue([]);
    vi.mocked(db.select).mockReturnValue({ from: mockFromFn } as never);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/trash`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with read options (no CSRF)', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, ownerId: mockUserId })
      );
      vi.mocked(db.query.pages.findMany).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/trash`);
      await GET(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session', 'mcp'] }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/trash`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return scope error when MCP scope check fails', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, ownerId: mockUserId })
      );
      const scopeErrorResponse = NextResponse.json({ error: 'Scope denied' }, { status: 403 });
      vi.mocked(checkMCPDriveScope).mockReturnValue(scopeErrorResponse);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/trash`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(403);
    });

    it('should allow owner to view trash', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, ownerId: mockUserId })
      );
      vi.mocked(db.query.pages.findMany).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/trash`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });

    it('should allow admin to view trash', async () => {
      // Drive owned by another user
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, ownerId: 'other_user' })
      );
      // User is an admin member
      mockFromFn.mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ userId: mockUserId, role: 'ADMIN' }]),
        }),
      });
      vi.mocked(db.query.pages.findMany).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/trash`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });

    it('should return 403 when user is not owner or admin', async () => {
      // Drive owned by another user
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, ownerId: 'other_user' })
      );
      // User has no admin membership
      mockFromFn.mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/trash`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can view trash');
    });
  });

  describe('response contract', () => {
    it('should return tree of trashed pages', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, ownerId: mockUserId })
      );
      const trashedPages = [
        { id: 'page_1', name: 'Trashed Page', parentId: null, driveId: mockDriveId, isTrashed: true, children: [] },
      ];
      vi.mocked(db.query.pages.findMany).mockResolvedValue(trashedPages);
      const tree = [{ id: 'page_1', name: 'Trashed Page', children: [] }];
      vi.mocked(buildTree).mockReturnValue(tree);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/trash`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(tree);
      expect(buildTree).toHaveBeenCalledWith(trashedPages);
    });

    it('should return empty array when no trashed pages', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, ownerId: mockUserId })
      );
      vi.mocked(db.query.pages.findMany).mockResolvedValue([]);
      vi.mocked(buildTree).mockReturnValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/trash`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database throws', async () => {
      vi.mocked(db.query.drives.findFirst).mockRejectedValue(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/trash`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch trashed pages');
    });

    it('should log error when database throws', async () => {
      const error = new Error('Fetch failure');
      vi.mocked(db.query.drives.findFirst).mockRejectedValue(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/trash`);
      await GET(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Failed to fetch trashed pages:', error);
    });
  });
});
