import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/lib/server', () => ({
  getUserAccessLevel: vi.fn(),
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
  isAuthError: vi.fn((result) => 'error' in result),
}));

import { authenticateRequestWithOptions } from '@/lib/auth';
import { getUserAccessLevel } from '@pagespace/lib/server';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock permissions
const mockPermissions = (overrides?: Partial<{
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
}>) => ({
  canView: overrides?.canView ?? true,
  canEdit: overrides?.canEdit ?? false,
  canShare: overrides?.canShare ?? false,
  canDelete: overrides?.canDelete ?? false,
});

describe('GET /api/pages/[pageId]/permissions/check', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';

  const createRequest = () => {
    return new Request(`https://example.com/api/pages/${mockPageId}/permissions/check`, {
      method: 'GET',
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (getUserAccessLevel as Mock).mockResolvedValue(mockPermissions());
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(401);
    });
  });

  describe('permission check', () => {
    it('returns full permissions for user with all access', async () => {
      (getUserAccessLevel as Mock).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.canView).toBe(true);
      expect(body.canEdit).toBe(true);
      expect(body.canShare).toBe(true);
      expect(body.canDelete).toBe(true);
    });

    it('returns view-only permissions', async () => {
      (getUserAccessLevel as Mock).mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.canView).toBe(true);
      expect(body.canEdit).toBe(false);
      expect(body.canShare).toBe(false);
      expect(body.canDelete).toBe(false);
    });

    it('returns no permissions when user has no access', async () => {
      (getUserAccessLevel as Mock).mockResolvedValue(null);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.canView).toBe(false);
      expect(body.canEdit).toBe(false);
      expect(body.canShare).toBe(false);
      expect(body.canDelete).toBe(false);
    });

    it('returns edit and view permissions', async () => {
      (getUserAccessLevel as Mock).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.canView).toBe(true);
      expect(body.canEdit).toBe(true);
      expect(body.canShare).toBe(false);
      expect(body.canDelete).toBe(false);
    });

    it('returns share permission without delete', async () => {
      (getUserAccessLevel as Mock).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: false,
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.canShare).toBe(true);
      expect(body.canDelete).toBe(false);
    });
  });

  describe('error handling', () => {
    it('returns 500 when getUserAccessLevel throws', async () => {
      (getUserAccessLevel as Mock).mockRejectedValue(new Error('Database error'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to check permissions');
    });
  });

  describe('async params handling', () => {
    it('correctly awaits params Promise', async () => {
      const delayedParams = new Promise<{ pageId: string }>((resolve) => {
        setTimeout(() => resolve({ pageId: 'delayed_page_id' }), 10);
      });

      // Since we can't easily test that await was called,
      // we verify the endpoint works with a delayed promise
      const response = await GET(createRequest(), { params: delayedParams });

      expect(response.status).toBe(200);
      expect(getUserAccessLevel).toHaveBeenCalledWith(mockUserId, 'delayed_page_id');
    });
  });
});
