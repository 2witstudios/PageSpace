import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/integrations/audit
// ============================================================================

vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => {
  const integrationAuditLog = {
    driveId: 'col_driveId',
    connectionId: 'col_connectionId',
    success: 'col_success',
    agentId: 'col_agentId',
    createdAt: 'col_createdAt',
    toolName: 'col_toolName',
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(),
        })),
      })),
      query: {
        integrationAuditLog: {
          findMany: vi.fn(),
        },
      },
    },
  };
});

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('../audit-filters', () => ({
  parseAuditListParams: vi.fn(),
  buildAuditLogWhereClause: vi.fn(() => 'mock-where-clause'),
}));

import { GET } from '../route';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { parseAuditListParams, buildAuditLogWhereClause } from '../audit-filters';
import { db } from '@pagespace/db/db';

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

const MOCK_USER_ID = 'user_123';
const MOCK_DRIVE_ID = 'drive_abc';

const mockAuditLog = (overrides: Record<string, unknown> = {}) => ({
  id: 'log-1',
  driveId: MOCK_DRIVE_ID,
  agentId: 'agent-1',
  userId: MOCK_USER_ID,
  connectionId: 'conn-1',
  toolName: 'create_issue',
  inputSummary: 'Created an issue',
  success: true,
  responseCode: 200,
  errorType: null,
  errorMessage: null,
  durationMs: 150,
  createdAt: new Date('2024-06-01'),
  ...overrides,
});

function setupDbMocks(countResult: { count: number }[], logs: unknown[]) {
  // db.select().from().where() for count query
  const mockWhere = vi.fn().mockResolvedValue(countResult);
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

  // db.query.integrationAuditLog.findMany() for logs query
  vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue(logs as never);
}

// ============================================================================
// GET /api/drives/[driveId]/integrations/audit
// ============================================================================

describe('GET /api/drives/[driveId]/integrations/audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/drives/d/integrations/audit');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER',
      });

      const request = new Request('https://example.com/api/drives/d/integrations/audit');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Admin access required');
    });

    it('should allow owner access', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      vi.mocked(parseAuditListParams).mockReturnValue({
        ok: true,
        data: {
          limit: 50, offset: 0,
          connectionId: null, success: null, agentId: null,
          dateFrom: null, dateTo: null, toolName: null,
        },
      });
      setupDbMocks([{ count: 0 }], []);

      const request = new Request('https://example.com/api/drives/d/integrations/audit');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(200);
    });

    it('should allow admin access', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: true, isMember: true, role: 'ADMIN',
      });
      vi.mocked(parseAuditListParams).mockReturnValue({
        ok: true,
        data: {
          limit: 50, offset: 0,
          connectionId: null, success: null, agentId: null,
          dateFrom: null, dateTo: null, toolName: null,
        },
      });
      setupDbMocks([{ count: 0 }], []);

      const request = new Request('https://example.com/api/drives/d/integrations/audit');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(200);
    });
  });

  describe('query param validation', () => {
    beforeEach(() => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
    });

    it('should return 400 when params fail validation', async () => {
      vi.mocked(parseAuditListParams).mockReturnValue({
        ok: false,
        error: 'limit must be an integer',
      });

      const request = new Request('https://example.com/api/drives/d/integrations/audit?limit=abc');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('limit must be an integer');
    });
  });

  describe('response contract', () => {
    beforeEach(() => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      vi.mocked(parseAuditListParams).mockReturnValue({
        ok: true,
        data: {
          limit: 50, offset: 0,
          connectionId: null, success: null, agentId: null,
          dateFrom: null, dateTo: null, toolName: null,
        },
      });
    });

    it('should return paginated logs with total count', async () => {
      const log = mockAuditLog();
      setupDbMocks([{ count: 42 }], [log]);

      const request = new Request('https://example.com/api/drives/d/integrations/audit');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.total).toBe(42);
      expect(body.logs).toHaveLength(1);
      expect(body.logs[0]).toMatchObject({
        id: 'log-1',
        driveId: MOCK_DRIVE_ID,
        agentId: 'agent-1',
        userId: MOCK_USER_ID,
        connectionId: 'conn-1',
        toolName: 'create_issue',
        inputSummary: 'Created an issue',
        success: true,
        responseCode: 200,
        errorType: null,
        errorMessage: null,
        durationMs: 150,
      });
    });

    it('should return empty logs array and total 0', async () => {
      setupDbMocks([{ count: 0 }], []);

      const request = new Request('https://example.com/api/drives/d/integrations/audit');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.logs).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should default total to 0 when count result is empty', async () => {
      setupDbMocks([], []);

      const request = new Request('https://example.com/api/drives/d/integrations/audit');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.total).toBe(0);
    });

    it('should call buildAuditLogWhereClause with driveId and parsed filters', async () => {
      setupDbMocks([{ count: 0 }], []);

      const request = new Request('https://example.com/api/drives/d/integrations/audit');
      await GET(request, createContext(MOCK_DRIVE_ID));

      expect(buildAuditLogWhereClause).toHaveBeenCalledWith(
        MOCK_DRIVE_ID,
        {
          connectionId: null,
          success: null,
          agentId: null,
          dateFrom: null,
          dateTo: null,
          toolName: null,
        }
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 and log when db throws', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      vi.mocked(parseAuditListParams).mockReturnValue({
        ok: true,
        data: {
          limit: 50, offset: 0,
          connectionId: null, success: null, agentId: null,
          dateFrom: null, dateTo: null, toolName: null,
        },
      });
      const error = new Error('DB failed');
      const mockWhere = vi.fn().mockRejectedValueOnce(error);
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);
      vi.mocked(db.query.integrationAuditLog.findMany).mockRejectedValueOnce(error);

      const request = new Request('https://example.com/api/drives/d/integrations/audit');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch audit logs');
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching integration audit logs:',
        error
      );
    });
  });
});
