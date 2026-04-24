import { beforeEach, describe, it, expect, vi } from 'vitest';

// Mock @pagespace/db to provide the Drizzle operators and schema references
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ _type: 'and', conditions })),
  eq: vi.fn((col: unknown, val: unknown) => ({ _type: 'eq', col, val })),
  gte: vi.fn((col: unknown, val: unknown) => ({ _type: 'gte', col, val })),
  lte: vi.fn((col: unknown, val: unknown) => ({ _type: 'lte', col, val })),
}));
vi.mock('@pagespace/db/schema/integrations', () => ({
  integrationAuditLog: {
    driveId: 'col_driveId',
    connectionId: 'col_connectionId',
    success: 'col_success',
    agentId: 'col_agentId',
    createdAt: 'col_createdAt',
    toolName: 'col_toolName',
  },
}));

// Mock @pagespace/lib to provide isValidId
vi.mock('@pagespace/lib/validators/id-validators', () => ({
    isValidId: vi.fn((id: string) => /^[a-z0-9]{20,30}$/.test(id)),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

import {
  parseAuditFilterParams,
  parseAuditListParams,
  buildAuditLogWhereClause,
} from '../audit-filters';
import type { AuditFilterParams } from '../audit-filters';
import { and, eq, gte, lte } from '@pagespace/db/operators'
import { integrationAuditLog } from '@pagespace/db/schema/integrations';

// ============================================================================
// Test Helpers
// ============================================================================

const createSearchParams = (params: Record<string, string> = {}): URLSearchParams => {
  return new URLSearchParams(params);
};

const VALID_CUID = 'clg8k9x0y000008l1d4hv8x0z';

// ============================================================================
// parseAuditFilterParams
// ============================================================================

describe('parseAuditFilterParams', () => {
  describe('with no params', () => {
    it('should return ok with all null filters', () => {
      const result = parseAuditFilterParams(createSearchParams());

      expect(result.ok).toBe(true);
      expect(result).toEqual({
        ok: true,
        data: {
          connectionId: null,
          success: null,
          agentId: null,
          dateFrom: null,
          dateTo: null,
          toolName: null,
        },
      });
    });
  });

  describe('connectionId validation', () => {
    it('should accept a valid connectionId', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ connectionId: VALID_CUID })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.connectionId).toBe(VALID_CUID);
    });

    it('should reject an invalid connectionId', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ connectionId: 'not-valid!' })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid connectionId format');
    });

    it('should treat empty connectionId as null', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ connectionId: '' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.connectionId).toBe(null);
    });

    it('should treat whitespace-only connectionId as null', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ connectionId: '   ' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.connectionId).toBe(null);
    });
  });

  describe('agentId validation', () => {
    it('should accept a valid agentId', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ agentId: VALID_CUID })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.agentId).toBe(VALID_CUID);
    });

    it('should reject an invalid agentId', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ agentId: 'bad-id!' })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid agentId format');
    });

    it('should treat empty agentId as null', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ agentId: '' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.agentId).toBe(null);
    });
  });

  describe('success validation', () => {
    it('should parse success=true', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ success: 'true' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.success).toBe(true);
    });

    it('should parse success=false', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ success: 'false' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.success).toBe(false);
    });

    it('should reject invalid success value', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ success: 'maybe' })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid success value (must be "true" or "false")');
    });

    it('should treat missing success as null', () => {
      const result = parseAuditFilterParams(createSearchParams());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.success).toBe(null);
    });
  });

  describe('date validation', () => {
    it('should parse valid dateFrom', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ dateFrom: '2024-01-15T00:00:00Z' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.dateFrom).toBeInstanceOf(Date);
    });

    it('should parse valid dateTo', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ dateTo: '2024-12-31T23:59:59Z' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.dateTo).toBeInstanceOf(Date);
    });

    it('should reject invalid dateFrom format', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ dateFrom: 'not-a-date' })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid dateFrom format');
    });

    it('should reject invalid dateTo format', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ dateTo: 'not-a-date' })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid dateTo format');
    });

    it('should reject dateFrom after dateTo', () => {
      const result = parseAuditFilterParams(
        createSearchParams({
          dateFrom: '2024-12-31T00:00:00Z',
          dateTo: '2024-01-01T00:00:00Z',
        })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('dateFrom must be before or equal to dateTo');
    });

    it('should accept dateFrom equal to dateTo', () => {
      const date = '2024-06-15T12:00:00Z';
      const result = parseAuditFilterParams(
        createSearchParams({ dateFrom: date, dateTo: date })
      );

      expect(result.ok).toBe(true);
    });

    it('should treat empty dateFrom as null', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ dateFrom: '' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.dateFrom).toBe(null);
    });
  });

  describe('toolName validation', () => {
    it('should accept a valid toolName', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ toolName: 'create_issue' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.toolName).toBe('create_issue');
    });

    it('should reject toolName exceeding max length', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ toolName: 'a'.repeat(256) })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('toolName exceeds max length of 255');
    });

    it('should treat empty toolName as null', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ toolName: '' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.toolName).toBe(null);
    });

    it('should treat whitespace-only toolName as null', () => {
      const result = parseAuditFilterParams(
        createSearchParams({ toolName: '   ' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.toolName).toBe(null);
    });
  });
});

// ============================================================================
// parseAuditListParams
// ============================================================================

describe('parseAuditListParams', () => {
  it('should return default limit and offset when not provided', () => {
    const result = parseAuditListParams(createSearchParams());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    }
  });

  it('should parse valid limit', () => {
    const result = parseAuditListParams(createSearchParams({ limit: '25' }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.limit).toBe(25);
  });

  it('should cap limit at max (200)', () => {
    const result = parseAuditListParams(createSearchParams({ limit: '500' }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.limit).toBe(200);
  });

  it('should reject limit < 1', () => {
    const result = parseAuditListParams(createSearchParams({ limit: '0' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('limit must be >= 1');
  });

  it('should reject non-integer limit', () => {
    const result = parseAuditListParams(createSearchParams({ limit: '2.5' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('limit must be an integer');
  });

  it('should parse valid offset', () => {
    const result = parseAuditListParams(createSearchParams({ offset: '100' }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.offset).toBe(100);
  });

  it('should reject offset < 0', () => {
    const result = parseAuditListParams(createSearchParams({ offset: '-1' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('offset must be >= 0');
  });

  it('should reject non-integer offset', () => {
    const result = parseAuditListParams(createSearchParams({ offset: '1.5' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('offset must be an integer');
  });

  it('should treat empty limit as default', () => {
    const result = parseAuditListParams(createSearchParams({ limit: '' }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.limit).toBe(50);
  });

  it('should treat whitespace limit as default', () => {
    const result = parseAuditListParams(createSearchParams({ limit: '   ' }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.limit).toBe(50);
  });

  it('should propagate filter errors', () => {
    const result = parseAuditListParams(
      createSearchParams({ success: 'invalid' })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Invalid success value (must be "true" or "false")');
  });

  it('should include filter data alongside limit and offset', () => {
    const result = parseAuditListParams(
      createSearchParams({
        limit: '10',
        offset: '5',
        toolName: 'my_tool',
        success: 'true',
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.limit).toBe(10);
      expect(result.data.offset).toBe(5);
      expect(result.data.toolName).toBe('my_tool');
      expect(result.data.success).toBe(true);
    }
  });

  it('should accept offset with no max bound', () => {
    const result = parseAuditListParams(createSearchParams({ offset: '999999' }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.offset).toBe(999999);
  });
});

// ============================================================================
// buildAuditLogWhereClause
// ============================================================================

describe('buildAuditLogWhereClause', () => {
  const driveId = 'test-drive-id';

  const emptyFilters: AuditFilterParams = {
    connectionId: null,
    success: null,
    agentId: null,
    dateFrom: null,
    dateTo: null,
    toolName: null,
  };

  it('should build clause with only driveId when no filters', () => {
    const result = buildAuditLogWhereClause(driveId, emptyFilters);

    // With only one condition, and() is not used
    expect(eq).toHaveBeenCalledWith(integrationAuditLog.driveId, driveId);
    expect(result).toEqual({ _type: 'eq', col: 'col_driveId', val: driveId });
  });

  it('should add connectionId filter', () => {
    buildAuditLogWhereClause(driveId, {
      ...emptyFilters,
      connectionId: 'conn-123',
    });

    expect(eq).toHaveBeenCalledWith(integrationAuditLog.connectionId, 'conn-123');
    expect(and).toHaveBeenCalledWith(
      { _type: 'eq', col: 'col_driveId', val: driveId },
      { _type: 'eq', col: 'col_connectionId', val: 'conn-123' },
    );
  });

  it('should add success filter', () => {
    buildAuditLogWhereClause(driveId, {
      ...emptyFilters,
      success: true,
    });

    expect(eq).toHaveBeenCalledWith(integrationAuditLog.success, true);
    expect(and).toHaveBeenCalledWith(
      { _type: 'eq', col: 'col_driveId', val: driveId },
      { _type: 'eq', col: 'col_success', val: true },
    );
  });

  it('should add success=false filter', () => {
    buildAuditLogWhereClause(driveId, {
      ...emptyFilters,
      success: false,
    });

    expect(eq).toHaveBeenCalledWith(integrationAuditLog.success, false);
  });

  it('should add agentId filter', () => {
    buildAuditLogWhereClause(driveId, {
      ...emptyFilters,
      agentId: 'agent-456',
    });

    expect(eq).toHaveBeenCalledWith(integrationAuditLog.agentId, 'agent-456');
  });

  it('should add dateFrom filter', () => {
    const dateFrom = new Date('2024-01-01');
    buildAuditLogWhereClause(driveId, {
      ...emptyFilters,
      dateFrom,
    });

    expect(gte).toHaveBeenCalledWith(integrationAuditLog.createdAt, dateFrom);
  });

  it('should add dateTo filter', () => {
    const dateTo = new Date('2024-12-31');
    buildAuditLogWhereClause(driveId, {
      ...emptyFilters,
      dateTo,
    });

    expect(lte).toHaveBeenCalledWith(integrationAuditLog.createdAt, dateTo);
  });

  it('should add toolName filter', () => {
    buildAuditLogWhereClause(driveId, {
      ...emptyFilters,
      toolName: 'search_issues',
    });

    expect(eq).toHaveBeenCalledWith(integrationAuditLog.toolName, 'search_issues');
  });

  it('should combine all filters with and()', () => {
    const dateFrom = new Date('2024-01-01');
    const dateTo = new Date('2024-12-31');

    buildAuditLogWhereClause(driveId, {
      connectionId: 'conn-1',
      success: false,
      agentId: 'agent-1',
      dateFrom,
      dateTo,
      toolName: 'test_tool',
    });

    // 7 conditions total: driveId + 6 filters
    expect(and).toHaveBeenCalledWith(
      { _type: 'eq', col: 'col_driveId', val: driveId },
      { _type: 'eq', col: 'col_connectionId', val: 'conn-1' },
      { _type: 'eq', col: 'col_success', val: false },
      { _type: 'eq', col: 'col_agentId', val: 'agent-1' },
      { _type: 'gte', col: 'col_createdAt', val: dateFrom },
      { _type: 'lte', col: 'col_createdAt', val: dateTo },
      { _type: 'eq', col: 'col_toolName', val: 'test_tool' },
    );
  });
});
