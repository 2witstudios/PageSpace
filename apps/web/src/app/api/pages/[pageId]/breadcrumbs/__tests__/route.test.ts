/**
 * Contract tests for GET /api/pages/[pageId]/breadcrumbs
 *
 * Tests verify:
 * - Authentication via authenticateRequestWithOptions
 * - Authorization via canUserViewPage
 * - Recursive CTE breadcrumb query with drive info
 * - Null drive info handling
 * - Response mapping
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
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    execute: vi.fn(),
  },
  pages: 'pages_table',
  drives: 'drives_table',
  sql: vi.fn(),
}));

vi.mock('@/lib/audit/route-audit', () => ({
  logAuditEvent: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { db } from '@pagespace/db';

// Test helpers
const mockUserId = 'user_123';
const mockPageId = 'page_abc';

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

const createRequest = () =>
  new Request(`https://example.com/api/pages/${mockPageId}/breadcrumbs`, { method: 'GET' });

const mockParams = { params: Promise.resolve({ pageId: mockPageId }) };

describe('GET /api/pages/[pageId]/breadcrumbs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    // Default: return breadcrumb rows with drive info
    vi.mocked(db.execute).mockResolvedValue({
      rows: [
        {
          id: 'root_page',
          title: 'Root',
          type: 'FOLDER',
          driveId: 'drive_1',
          parentId: null,
          drive_id: 'drive_1',
          drive_slug: 'my-drive',
          drive_name: 'My Drive',
          depth: 2,
        },
        {
          id: mockPageId,
          title: 'Current Page',
          type: 'DOCUMENT',
          driveId: 'drive_1',
          parentId: 'root_page',
          drive_id: 'drive_1',
          drive_slug: 'my-drive',
          drive_name: 'My Drive',
          depth: 1,
        },
      ],
    } as never);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), mockParams);

      expect(response.status).toBe(401);
      expect(canUserViewPage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user cannot view the page', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(createRequest(), mockParams);

      expect(response.status).toBe(403);
    });

    it('checks permissions with correct userId and pageId', async () => {
      await GET(createRequest(), mockParams);

      expect(canUserViewPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });
  });

  describe('breadcrumb retrieval', () => {
    it('returns breadcrumbs with drive info', async () => {
      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body[0].id).toBe('root_page');
      expect(body[0].drive).toEqual({
        id: 'drive_1',
        slug: 'my-drive',
        name: 'My Drive',
      });
      expect(body[1].id).toBe(mockPageId);
    });

    it('returns null drive when drive fields are missing', async () => {
      vi.mocked(db.execute).mockResolvedValue({
        rows: [
          {
            id: mockPageId,
            title: 'Orphan Page',
            type: 'DOCUMENT',
            driveId: 'drive_1',
            parentId: null,
            drive_id: null,
            drive_slug: null,
            drive_name: null,
            depth: 1,
          },
        ],
      } as never);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body[0].drive).toBeNull();
    });

    it('returns null drive when drive_slug is missing but drive_id present', async () => {
      vi.mocked(db.execute).mockResolvedValue({
        rows: [
          {
            id: mockPageId,
            title: 'Page',
            type: 'DOCUMENT',
            driveId: 'drive_1',
            parentId: null,
            drive_id: 'drive_1',
            drive_slug: null,
            drive_name: 'My Drive',
            depth: 1,
          },
        ],
      } as never);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(body[0].drive).toBeNull();
    });

    it('returns null drive when drive_name is missing but others present', async () => {
      vi.mocked(db.execute).mockResolvedValue({
        rows: [
          {
            id: mockPageId,
            title: 'Page',
            type: 'DOCUMENT',
            driveId: 'drive_1',
            parentId: null,
            drive_id: 'drive_1',
            drive_slug: 'my-drive',
            drive_name: null,
            depth: 1,
          },
        ],
      } as never);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(body[0].drive).toBeNull();
    });

    it('returns empty array when no breadcrumbs (page not found via CTE)', async () => {
      vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(0);
    });
  });
});
