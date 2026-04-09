import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/integrations/audit/export
// ============================================================================

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn(),
}));

vi.mock('@pagespace/db', () => {
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
      query: {
        integrationAuditLog: {
          findMany: vi.fn(),
        },
      },
    },
    integrationAuditLog,
    desc: vi.fn((col: unknown) => ({ _type: 'desc', col })),
    and: vi.fn((...args: unknown[]) => ({ _type: 'and', args })),
    eq: vi.fn((a: unknown, b: unknown) => ({ _type: 'eq', a, b })),
    gte: vi.fn(),
    lte: vi.fn(),
  };
});

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('../../audit-filters', () => ({
  parseAuditFilterParams: vi.fn(),
  buildAuditLogWhereClause: vi.fn(() => 'mock-where-clause'),
}));

vi.mock('date-fns', () => ({
  format: vi.fn((date: Date, fmt: string) => {
    if (fmt === 'yyyy-MM-dd HH:mm:ss') {
      return '2024-06-01 12:00:00';
    }
    if (fmt === 'yyyy-MM-dd') {
      return '2024-06-01';
    }
    return date.toISOString();
  }),
}));

import { GET } from '../route';
import { loggers } from '@pagespace/lib/server';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { parseAuditFilterParams, buildAuditLogWhereClause } from '../../audit-filters';
import { db } from '@pagespace/db';

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

// ============================================================================
// GET /api/drives/[driveId]/integrations/audit/export
// ============================================================================

describe('GET /api/drives/[driveId]/integrations/audit/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER',
      });

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Admin access required');
    });

    it('should allow owner access', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      vi.mocked(parseAuditFilterParams).mockReturnValue({
        ok: true,
        data: {
          connectionId: null, success: null, agentId: null,
          dateFrom: null, dateTo: null, toolName: null,
        },
      });
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(200);
    });

    it('should allow admin access', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: true, isMember: true, role: 'ADMIN',
      });
      vi.mocked(parseAuditFilterParams).mockReturnValue({
        ok: true,
        data: {
          connectionId: null, success: null, agentId: null,
          dateFrom: null, dateTo: null, toolName: null,
        },
      });
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(200);
    });
  });

  describe('filter validation', () => {
    beforeEach(() => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
    });

    it('should return 400 when filter params are invalid', async () => {
      vi.mocked(parseAuditFilterParams).mockReturnValue({
        ok: false,
        error: 'Invalid connectionId format',
      });

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export?connectionId=bad');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid connectionId format');
    });
  });

  describe('CSV response', () => {
    beforeEach(() => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      vi.mocked(parseAuditFilterParams).mockReturnValue({
        ok: true,
        data: {
          connectionId: null, success: null, agentId: null,
          dateFrom: null, dateTo: null, toolName: null,
        },
      });
    });

    it('should return CSV with correct headers and content type', async () => {
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));

      expect(response.headers.get('Content-Type')).toBe('text/csv');
      expect(response.headers.get('Content-Disposition')).toContain('attachment; filename=');
      expect(response.headers.get('Content-Disposition')).toContain('integration-audit-logs-');
      expect(response.headers.get('Content-Disposition')).toContain('.csv');

      const csv = await response.text();
      const headerLine = csv.split('\n')[0];
      expect(headerLine).toBe(
        'Timestamp,Tool Name,Agent ID,Connection ID,Success,Response Code,Duration (ms),Error Type,Error Message'
      );
    });

    it('should format log entries as CSV rows', async () => {
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([
        {
          id: 'log-1',
          driveId: MOCK_DRIVE_ID,
          agentId: 'agent-1',
          userId: MOCK_USER_ID,
          connectionId: 'conn-1',
          toolName: 'create_issue',
          inputSummary: 'Created issue',
          success: true,
          responseCode: 200,
          errorType: null,
          errorMessage: null,
          durationMs: 150,
          createdAt: new Date('2024-06-01'),
        },
      ] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const csv = await response.text();
      const lines = csv.split('\n');

      expect(lines).toHaveLength(2); // header + 1 data row
      // Row should contain timestamp, tool, agent, connection, success, code, duration, error type, error msg
      expect(lines[1]).toContain('create_issue');
      expect(lines[1]).toContain('Success');
      expect(lines[1]).toContain('200');
      expect(lines[1]).toContain('150');
    });

    it('should format failed log entries', async () => {
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([
        {
          id: 'log-2',
          driveId: MOCK_DRIVE_ID,
          agentId: null,
          userId: MOCK_USER_ID,
          connectionId: 'conn-1',
          toolName: 'search_repos',
          inputSummary: null,
          success: false,
          responseCode: 500,
          errorType: 'TIMEOUT',
          errorMessage: 'Request timed out',
          durationMs: 30000,
          createdAt: new Date('2024-06-01'),
        },
      ] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const csv = await response.text();
      const lines = csv.split('\n');

      expect(lines[1]).toContain('Failure');
      expect(lines[1]).toContain('TIMEOUT');
      expect(lines[1]).toContain('Request timed out');
    });

    it('should handle log with null createdAt', async () => {
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([
        {
          id: 'log-3',
          driveId: MOCK_DRIVE_ID,
          agentId: null,
          userId: null,
          connectionId: 'conn-1',
          toolName: 'test',
          inputSummary: null,
          success: true,
          responseCode: null,
          errorType: null,
          errorMessage: null,
          durationMs: null,
          createdAt: null,
        },
      ] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const csv = await response.text();
      const lines = csv.split('\n');

      // First field (timestamp) should be empty since createdAt is null
      expect(lines[1].startsWith(',')).toBe(true);
    });

    it('should escape CSV values containing commas', async () => {
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([
        {
          id: 'log-4',
          driveId: MOCK_DRIVE_ID,
          agentId: null,
          userId: null,
          connectionId: 'conn-1',
          toolName: 'test',
          inputSummary: null,
          success: false,
          responseCode: null,
          errorType: null,
          errorMessage: 'Error, with comma',
          durationMs: null,
          createdAt: new Date('2024-06-01'),
        },
      ] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const csv = await response.text();

      // Values with commas should be quoted
      expect(csv).toContain('"Error, with comma"');
    });

    it('should escape CSV values containing double quotes', async () => {
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([
        {
          id: 'log-5',
          driveId: MOCK_DRIVE_ID,
          agentId: null,
          userId: null,
          connectionId: 'conn-1',
          toolName: 'test',
          inputSummary: null,
          success: false,
          responseCode: null,
          errorType: null,
          errorMessage: 'Error "with" quotes',
          durationMs: null,
          createdAt: new Date('2024-06-01'),
        },
      ] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const csv = await response.text();

      // Quotes within values should be doubled and wrapped
      expect(csv).toContain('"Error ""with"" quotes"');
    });

    it('should escape CSV values containing newlines', async () => {
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([
        {
          id: 'log-6',
          driveId: MOCK_DRIVE_ID,
          agentId: null,
          userId: null,
          connectionId: 'conn-1',
          toolName: 'test',
          inputSummary: null,
          success: false,
          responseCode: null,
          errorType: null,
          errorMessage: 'Line1\nLine2',
          durationMs: null,
          createdAt: new Date('2024-06-01'),
        },
      ] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const csv = await response.text();

      expect(csv).toContain('"Line1\nLine2"');
    });

    it('should escape CSV values containing carriage returns', async () => {
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([
        {
          id: 'log-cr',
          driveId: MOCK_DRIVE_ID,
          agentId: null,
          userId: null,
          connectionId: 'conn-1',
          toolName: 'test',
          inputSummary: null,
          success: false,
          responseCode: null,
          errorType: null,
          errorMessage: 'Line1\rLine2',
          durationMs: null,
          createdAt: new Date('2024-06-01'),
        },
      ] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const csv = await response.text();

      expect(csv).toContain('"Line1\rLine2"');
    });

    it('should prevent formula injection by prefixing dangerous characters', async () => {
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([
        {
          id: 'log-inject',
          driveId: MOCK_DRIVE_ID,
          agentId: null,
          userId: null,
          connectionId: 'conn-1',
          toolName: '=cmd()',
          inputSummary: null,
          success: true,
          responseCode: null,
          errorType: null,
          errorMessage: null,
          durationMs: null,
          createdAt: new Date('2024-06-01'),
        },
      ] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const csv = await response.text();

      // Formula injection should be prevented with a leading single quote
      expect(csv).toContain("'=cmd()");
    });

    it('should handle null and undefined values', async () => {
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([
        {
          id: 'log-null',
          driveId: MOCK_DRIVE_ID,
          agentId: null,
          userId: null,
          connectionId: 'conn-1',
          toolName: 'test',
          inputSummary: null,
          success: true,
          responseCode: null,
          errorType: null,
          errorMessage: null,
          durationMs: null,
          createdAt: new Date('2024-06-01'),
        },
      ] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const csv = await response.text();
      const lines = csv.split('\n');

      // Should not throw, null values become empty strings
      expect(lines).toHaveLength(2);
    });

    it('should call buildAuditLogWhereClause with parsed filters', async () => {
      vi.mocked(db.query.integrationAuditLog.findMany).mockResolvedValue([] as never);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
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
      vi.mocked(parseAuditFilterParams).mockReturnValue({
        ok: true,
        data: {
          connectionId: null, success: null, agentId: null,
          dateFrom: null, dateTo: null, toolName: null,
        },
      });
      const error = new Error('DB failed');
      vi.mocked(db.query.integrationAuditLog.findMany).mockRejectedValueOnce(error);

      const request = new Request('https://example.com/api/drives/d/integrations/audit/export');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export audit logs');
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error exporting integration audit logs:',
        error
      );
    });
  });
});
