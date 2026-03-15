/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/trash/[pageId]
//
// Tests permanent deletion of trashed pages with recursive child deletion.
// ============================================================================

const { mockTransaction } = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserDeletePage: vi.fn(),
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(),
  logPageActivity: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: vi.fn(),
      },
    },
    transaction: mockTransaction,
  },
  pages: { id: 'id', parentId: 'parentId', isTrashed: 'isTrashed' },
  favorites: { pageId: 'pageId' },
  pageTags: { pageId: 'pageId' },
  pagePermissions: { pageId: 'pageId' },
  chatMessages: { pageId: 'pageId' },
  channelMessages: { pageId: 'pageId' },
  eq: vi.fn(),
}));

import { DELETE } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserDeletePage } from '@pagespace/lib/server';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { db } from '@pagespace/db';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const MOCK_PAGE = {
  id: 'page_1',
  title: 'Test Page',
  driveId: 'drive_1',
  isTrashed: true,
};

/** Create a mock transaction object that satisfies recursivelyDelete */
function createMockTx() {
  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDeleteFn = vi.fn().mockReturnValue({ where: mockDeleteWhere });
  const mockSelectWhere = vi.fn().mockResolvedValue([]); // no children
  const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
  const mockSelectFn = vi.fn().mockReturnValue({ from: mockSelectFrom });

  return {
    select: mockSelectFn,
    delete: mockDeleteFn,
  };
}

// ============================================================================
// DELETE /api/trash/[pageId] - Contract Tests
// ============================================================================

describe('DELETE /api/trash/[pageId]', () => {
  const mockUserId = 'user_123';
  const pageId = 'page_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(canUserDeletePage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(MOCK_PAGE as any);

    // Transaction calls the callback with a tx object
    const tx = createMockTx();
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    vi.mocked(getActorInfo).mockResolvedValue({ name: 'Test User', email: 'test@example.com' } as any);
    vi.mocked(logPageActivity).mockReturnValue(undefined as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('http://localhost/api/trash/page_1', { method: 'DELETE' });
      const response = await DELETE(request, { params: Promise.resolve({ pageId }) });

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user cannot delete page', async () => {
      vi.mocked(canUserDeletePage).mockResolvedValue(false);

      const request = new Request('http://localhost/api/trash/page_1', { method: 'DELETE' });
      const response = await DELETE(request, { params: Promise.resolve({ pageId }) });

      expect(response.status).toBe(403);
    });

    it('should call canUserDeletePage with bypassCache option', async () => {
      const request = new Request('http://localhost/api/trash/page_1', { method: 'DELETE' });
      await DELETE(request, { params: Promise.resolve({ pageId }) });

      expect(canUserDeletePage).toHaveBeenCalledWith(mockUserId, pageId, { bypassCache: true });
    });
  });

  describe('validation', () => {
    it('should return 400 when page is not found', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as any);

      const request = new Request('http://localhost/api/trash/page_1', { method: 'DELETE' });
      const response = await DELETE(request, { params: Promise.resolve({ pageId }) });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Page is not in trash');
    });

    it('should return 400 when page is not trashed', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({
        ...MOCK_PAGE,
        isTrashed: false,
      } as any);

      const request = new Request('http://localhost/api/trash/page_1', { method: 'DELETE' });
      const response = await DELETE(request, { params: Promise.resolve({ pageId }) });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Page is not in trash');
    });
  });

  describe('success', () => {
    it('should permanently delete a trashed page', async () => {
      const request = new Request('http://localhost/api/trash/page_1', { method: 'DELETE' });
      const response = await DELETE(request, { params: Promise.resolve({ pageId }) });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Page permanently deleted.');
    });

    it('should execute deletion in a transaction', async () => {
      const request = new Request('http://localhost/api/trash/page_1', { method: 'DELETE' });
      await DELETE(request, { params: Promise.resolve({ pageId }) });

      expect(mockTransaction).toHaveBeenCalled();
    });

    it('should log page activity after deletion', async () => {
      const request = new Request('http://localhost/api/trash/page_1', { method: 'DELETE' });
      await DELETE(request, { params: Promise.resolve({ pageId }) });

      expect(getActorInfo).toHaveBeenCalledWith(mockUserId);
      expect(logPageActivity).toHaveBeenCalledWith(
        mockUserId,
        'delete',
        expect.objectContaining({
          id: pageId,
          title: 'Test Page',
          driveId: 'drive_1',
        }),
        expect.anything()
      );
    });

    it('should await params (Next.js 15 pattern)', async () => {
      const request = new Request('http://localhost/api/trash/page_1', { method: 'DELETE' });
      const paramsPromise = Promise.resolve({ pageId: 'page_42' });
      vi.mocked(canUserDeletePage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({
        ...MOCK_PAGE,
        id: 'page_42',
      } as any);

      await DELETE(request, { params: paramsPromise });

      expect(canUserDeletePage).toHaveBeenCalledWith(mockUserId, 'page_42', expect.anything());
    });
  });

  describe('error handling', () => {
    it('should return 500 when transaction fails', async () => {
      mockTransaction.mockRejectedValue(new Error('Transaction failed'));

      const request = new Request('http://localhost/api/trash/page_1', { method: 'DELETE' });
      const response = await DELETE(request, { params: Promise.resolve({ pageId }) });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to permanently delete page');
    });
  });
});
