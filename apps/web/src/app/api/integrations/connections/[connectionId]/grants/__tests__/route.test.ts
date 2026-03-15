/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/integrations/connections/[connectionId]/grants
//
// Tests the GET handler that lists grants for a connection.
// Only the connection owner (user-scoped) or drive member (drive-scoped) can access.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/integrations', () => ({
  getConnectionById: vi.fn(),
  listGrantsByConnection: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getConnectionById, listGrantsByConnection } from '@pagespace/lib/integrations';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { GET } from '../route';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (connectionId = 'conn_1') => ({
  params: Promise.resolve({ connectionId }),
});

const createRequest = () =>
  new Request('https://example.com/api/integrations/connections/conn_1/grants');

const mockConnection = (overrides: Record<string, unknown> = {}) => ({
  id: 'conn_1',
  userId: 'user_1',
  driveId: null,
  ...overrides,
});

const mockGrantRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'grant_1',
  agentId: 'agent_1',
  connectionId: 'conn_1',
  allowedTools: ['read_file'],
  deniedTools: null,
  readOnly: false,
  createdAt: new Date('2024-01-01'),
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/integrations/connections/[connectionId]/grants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getConnectionById).mockResolvedValue(mockConnection() as any);
    vi.mocked(listGrantsByConnection).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(401);
    });
  });

  describe('connection lookup', () => {
    it('should return 404 when connection not found', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(null);

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Connection not found');
    });
  });

  describe('authorization - user-scoped connection', () => {
    it('should return 403 when user does not own the connection', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(
        mockConnection({ userId: 'other_user' }) as any
      );

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Access denied');
    });

    it('should allow the connection owner to access grants', async () => {
      vi.mocked(listGrantsByConnection).mockResolvedValue([mockGrantRecord() as any]);

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.grants).toHaveLength(1);
    });
  });

  describe('authorization - drive-scoped connection', () => {
    it('should return 403 when user is not a drive member', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(
        mockConnection({ userId: null, driveId: 'drive_1' }) as any
      );
      vi.mocked(getDriveAccess).mockResolvedValue({ isMember: false } as any);

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Access denied');
    });

    it('should allow drive member to access grants', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(
        mockConnection({ userId: null, driveId: 'drive_1' }) as any
      );
      vi.mocked(getDriveAccess).mockResolvedValue({ isMember: true } as any);
      vi.mocked(listGrantsByConnection).mockResolvedValue([mockGrantRecord() as any]);

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.grants).toHaveLength(1);
    });
  });

  describe('authorization - no scope', () => {
    it('should return 403 when connection has neither userId nor driveId', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(
        mockConnection({ userId: null, driveId: null }) as any
      );

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Access denied');
    });
  });

  describe('success path', () => {
    it('should return grants with total count', async () => {
      vi.mocked(listGrantsByConnection).mockResolvedValue([
        mockGrantRecord() as any,
        mockGrantRecord({ id: 'grant_2', agentId: 'agent_2' }) as any,
      ]);

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.grants).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('should strip extra fields from grants', async () => {
      vi.mocked(listGrantsByConnection).mockResolvedValue([
        { ...mockGrantRecord(), secretField: 'should_not_appear' } as any,
      ]);

      const response = await GET(createRequest(), createContext());

      const body = await response.json();
      expect(body.grants[0]).not.toHaveProperty('secretField');
      expect(body.grants[0]).toHaveProperty('id');
      expect(body.grants[0]).toHaveProperty('agentId');
      expect(body.grants[0]).toHaveProperty('allowedTools');
    });

    it('should return empty array when no grants exist', async () => {
      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.grants).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(listGrantsByConnection).mockRejectedValue(new Error('DB error'));

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to list grants');
    });
  });
});
