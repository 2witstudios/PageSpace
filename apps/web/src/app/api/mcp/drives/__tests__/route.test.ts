/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { MCPAuthResult, SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/mcp/drives
//
// Tests POST (create drive) and GET (list drives) route handlers.
// Uses MCP authentication (authenticateMCPRequest).
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([
          {
            id: 'new_drive_id',
            name: 'Test Drive',
            slug: 'test-drive',
            ownerId: 'user_123',
          },
        ]),
      })),
    })),
  },
  drives: { id: 'id', name: 'name', slug: 'slug' },
}));

vi.mock('@/lib/auth', () => ({
  authenticateMCPRequest: vi.fn(),
  isAuthError: vi.fn(),
  isMCPAuthResult: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn().mockResolvedValue(undefined),
  createDriveEventPayload: vi.fn().mockReturnValue({ type: 'drive:created' }),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ name: 'Test User' }),
  logDriveActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  listAccessibleDrives: vi.fn().mockResolvedValue([]),
}));

// zod/v4 needs to be the real implementation for parse/safeParse
// but we mock it at the module level since it's used inline

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateMCPRequest, isAuthError, isMCPAuthResult } from '@/lib/auth';
import { broadcastDriveEvent } from '@/lib/websocket';
import { listAccessibleDrives } from '@pagespace/lib/services/drive-service';
import { POST, GET } from '../route';

const mockSessionAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockMCPAuth = (
  userId: string,
  allowedDriveIds: string[] = []
): MCPAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'mcp',
  tokenId: 'token_123',
  allowedDriveIds,
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

describe('POST /api/mcp/drives', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateMCPRequest).mockResolvedValue(mockSessionAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isMCPAuthResult).mockReturnValue(false);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: 'new_drive_id',
            name: 'Test Drive',
            slug: 'test-drive',
            ownerId: mockUserId,
          },
        ]),
      }),
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateMCPRequest).mockResolvedValue(mockAuthError(401));

      const request = new NextRequest('https://example.com/api/mcp/drives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Drive' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('scope restrictions', () => {
    it('should return 403 when MCP token is scoped to specific drives', async () => {
      vi.mocked(authenticateMCPRequest).mockResolvedValue(
        mockMCPAuth(mockUserId, ['drive_1', 'drive_2'])
      );
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      const request = new NextRequest('https://example.com/api/mcp/drives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Drive' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('scoped to specific drives');
    });

    it('should allow unscoped MCP token to create drives', async () => {
      vi.mocked(authenticateMCPRequest).mockResolvedValue(mockMCPAuth(mockUserId, []));
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      const request = new NextRequest('https://example.com/api/mcp/drives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Drive' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(201);
    });
  });

  describe('validation', () => {
    it('should return 400 for missing name', async () => {
      const request = new NextRequest('https://example.com/api/mcp/drives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 for name "Personal" (case insensitive)', async () => {
      const request = new NextRequest('https://example.com/api/mcp/drives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Personal' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Personal');
    });

    it('should return 400 for name "personal" (lowercase)', async () => {
      const request = new NextRequest('https://example.com/api/mcp/drives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'personal' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('success path', () => {
    it('should create drive and return 201', async () => {
      const request = new NextRequest('https://example.com/api/mcp/drives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Project' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body).toMatchObject({
        id: 'new_drive_id',
        name: 'Test Drive',
        slug: 'test-drive',
      });
    });

    it('should broadcast drive creation event', async () => {
      const request = new NextRequest('https://example.com/api/mcp/drives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Project' }),
      });
      await POST(request);

      expect(broadcastDriveEvent).toHaveBeenCalled();
    });

    it('should insert drive with correct owner', async () => {
      const request = new NextRequest('https://example.com/api/mcp/drives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Project' }),
      });
      await POST(request);

      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 on database error', async () => {
      vi.mocked(db.insert).mockImplementation(() => {
        throw new Error('DB error');
      });

      const request = new NextRequest('https://example.com/api/mcp/drives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Project' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create drive');
    });

    it('should log error on failure', async () => {
      const error = new Error('DB error');
      vi.mocked(db.insert).mockImplementation(() => {
        throw error;
      });

      const request = new NextRequest('https://example.com/api/mcp/drives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Project' }),
      });
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error in MCP drive creation:',
        error
      );
    });
  });
});

describe('GET /api/mcp/drives', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateMCPRequest).mockResolvedValue(mockSessionAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isMCPAuthResult).mockReturnValue(false);
    vi.mocked(listAccessibleDrives).mockResolvedValue([
      { id: 'drive_1', name: 'Drive One', slug: 'drive-one' },
      { id: 'drive_2', name: 'Drive Two', slug: 'drive-two' },
      { id: 'drive_3', name: 'Drive Three', slug: 'drive-three' },
    ] as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateMCPRequest).mockResolvedValue(mockAuthError(401));

      const request = new NextRequest('https://example.com/api/mcp/drives');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('unscoped token', () => {
    it('should return all accessible drives for unscoped token', async () => {
      const request = new NextRequest('https://example.com/api/mcp/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(3);
    });

    it('should return all accessible drives for session auth', async () => {
      vi.mocked(isMCPAuthResult).mockReturnValue(false);

      const request = new NextRequest('https://example.com/api/mcp/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(3);
    });
  });

  describe('scoped token', () => {
    it('should filter drives by MCP token scope', async () => {
      vi.mocked(authenticateMCPRequest).mockResolvedValue(
        mockMCPAuth(mockUserId, ['drive_1', 'drive_3'])
      );
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      const request = new NextRequest('https://example.com/api/mcp/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body.map((d: any) => d.id)).toEqual(['drive_1', 'drive_3']);
    });

    it('should return empty when scoped drives have no overlap', async () => {
      vi.mocked(authenticateMCPRequest).mockResolvedValue(
        mockMCPAuth(mockUserId, ['drive_999'])
      );
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      const request = new NextRequest('https://example.com/api/mcp/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(0);
    });

    it('should return all drives when MCP token has empty scope', async () => {
      vi.mocked(authenticateMCPRequest).mockResolvedValue(mockMCPAuth(mockUserId, []));
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      const request = new NextRequest('https://example.com/api/mcp/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(3);
    });
  });

  describe('error handling', () => {
    it('should return 500 on database error', async () => {
      vi.mocked(listAccessibleDrives).mockRejectedValue(new Error('DB error'));

      const request = new NextRequest('https://example.com/api/mcp/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch drives');
    });

    it('should log error on failure', async () => {
      const error = new Error('DB error');
      vi.mocked(listAccessibleDrives).mockRejectedValue(error);

      const request = new NextRequest('https://example.com/api/mcp/drives');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching drives:',
        error
      );
    });
  });
});
