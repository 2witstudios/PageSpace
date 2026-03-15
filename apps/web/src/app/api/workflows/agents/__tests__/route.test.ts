/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/workflows/agents
//
// Tests GET handler for listing AI_CHAT pages in a drive.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
  },
  pages: {
    id: 'id',
    title: 'title',
    type: 'type',
    driveId: 'driveId',
    isTrashed: 'isTrashed',
  },
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  isUserDriveMember: vi.fn(),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isUserDriveMember } from '@pagespace/lib';

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

// ============================================================================
// GET /api/workflows/agents
// ============================================================================

describe('GET /api/workflows/agents', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/workflows/agents?driveId=drive_1');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should use session-only auth without CSRF', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/workflows/agents?driveId=drive_1');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 when driveId is missing', async () => {
      const request = new Request('https://example.com/api/workflows/agents');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('driveId is required');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user is not a drive member', async () => {
      vi.mocked(isUserDriveMember).mockResolvedValue(false);

      const request = new Request('https://example.com/api/workflows/agents?driveId=drive_1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Not a member of this drive');
    });
  });

  describe('success', () => {
    it('should return empty array when no AI_CHAT pages exist', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/workflows/agents?driveId=drive_1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });

    it('should return AI_CHAT pages', async () => {
      const agents = [
        { id: 'page_1', title: 'Research Agent', type: 'AI_CHAT' },
        { id: 'page_2', title: 'Writing Agent', type: 'AI_CHAT' },
      ];
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(agents),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/workflows/agents?driveId=drive_1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(agents);
      expect(body).toHaveLength(2);
    });

    it('should check drive membership with correct params', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/workflows/agents?driveId=drive_abc');
      await GET(request);

      expect(isUserDriveMember).toHaveBeenCalledWith(mockUserId, 'drive_abc');
    });
  });
});
