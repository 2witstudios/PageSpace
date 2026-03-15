/**
 * Contract tests for POST /api/pages/[pageId]/view
 *
 * Tests verify:
 * - Authentication via authenticateRequestWithOptions
 * - Page existence check (404 if missing)
 * - Authorization via canUserViewPage (403 if denied)
 * - Upsert of page view record
 * - Error handling (500 on db failure)
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
  loggers: {
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/permissions', () => ({
  canUserViewPage: vi.fn(),
}));

vi.mock('@pagespace/db', () => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });

  return {
    db: {
      query: {
        pages: { findFirst: vi.fn() },
      },
      insert: insert,
    },
    pages: { id: 'id', driveId: 'driveId' },
    userPageViews: { userId: 'userId', pageId: 'pageId' },
    eq: vi.fn((a: unknown, b: unknown) => [a, b]),
  };
});

vi.mock('@pagespace/lib/api-utils', () => ({
  jsonResponse: vi.fn((data: unknown) => NextResponse.json(data)),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions';
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
  new Request(`https://example.com/api/pages/${mockPageId}/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

const mockParams = { params: Promise.resolve({ pageId: mockPageId }) };

/** @scaffold - ORM chain mocks until repository seam exists */
describe('POST /api/pages/[pageId]/view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    // @ts-expect-error - partial mock data
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: mockPageId,
      driveId: 'drive_123',
    });
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest(), mockParams);

      expect(response.status).toBe(401);
      expect(canUserViewPage).not.toHaveBeenCalled();
    });
  });

  describe('page existence', () => {
    it('returns 404 when page does not exist', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined);

      const response = await POST(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user cannot view the page', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await POST(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/forbidden/i);
    });

    it('checks permissions with correct userId and pageId', async () => {
      await POST(createRequest(), mockParams);

      expect(canUserViewPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });
  });

  describe('recording page view', () => {
    it('returns success when view is recorded', async () => {
      const response = await POST(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('inserts the page view record via upsert', async () => {
      await POST(createRequest(), mockParams);

      expect(db.insert).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe('error handling', () => {
    it('returns 500 when database throws', async () => {
      vi.mocked(db.query.pages.findFirst).mockRejectedValueOnce(new Error('DB error'));

      const response = await POST(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });

    it('returns 500 when insert throws', async () => {
      const onConflictDoUpdate = vi.fn().mockRejectedValueOnce(new Error('Insert failed'));
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
      vi.mocked(db.insert).mockReturnValue({ values } as never);

      const response = await POST(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});
