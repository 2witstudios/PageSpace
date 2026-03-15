/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for GET /api/admin/schema
//
// Tests admin schema introspection endpoint that returns database table info.
// ============================================================================

let mockAdminUser: { id: string; role: string; tokenVersion: number; adminRoleVersion: number; authTransport: string } | null = null;

vi.mock('@/lib/auth', () => ({
  withAdminAuth: vi.fn((handler: any) => {
    return async (request: Request) => {
      if (!mockAdminUser) {
        return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
      }
      return handler(mockAdminUser, request);
    };
  }),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    execute: vi.fn(),
  },
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { GET } from '../route';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

// ============================================================================
// Test Helpers
// ============================================================================

const setAdminAuth = (id = 'admin_1') => {
  mockAdminUser = { id, role: 'admin', tokenVersion: 1, adminRoleVersion: 0, authTransport: 'cookie' };
};

const setNoAuth = () => {
  mockAdminUser = null;
};

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/admin/schema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdminAuth();

    // Default: return empty result sets from all 4 queries
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [] } as any) // tables
      .mockResolvedValueOnce({ rows: [] } as any) // columns
      .mockResolvedValueOnce({ rows: [] } as any) // constraints
      .mockResolvedValueOnce({ rows: [] } as any); // indexes
  });

  describe('authentication & authorization', () => {
    it('should return 403 when not an admin', async () => {
      setNoAuth();

      const request = new Request('https://example.com/api/admin/schema');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });

    it('should allow admin access', async () => {
      const request = new Request('https://example.com/api/admin/schema');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe('success', () => {
    it('should return empty tables array when no tables exist', async () => {
      const request = new Request('https://example.com/api/admin/schema');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tables).toEqual([]);
    });

    it('should return schema data with columns, constraints, and indexes', async () => {
      // Reset execute mock to clear the beforeEach queue before adding test-specific values
      vi.mocked(db.execute)
        .mockReset()
        .mockResolvedValueOnce({
          rows: [{ table_name: 'users', table_type: 'BASE TABLE', table_comment: null }],
        } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              table_name: 'users',
              column_name: 'id',
              data_type: 'character varying',
              is_nullable: 'NO',
              column_default: null,
              character_maximum_length: 128,
              numeric_precision: null,
              numeric_scale: null,
              ordinal_position: 1,
              column_comment: null,
            },
            {
              table_name: 'users',
              column_name: 'email',
              data_type: 'character varying',
              is_nullable: 'NO',
              column_default: null,
              character_maximum_length: 256,
              numeric_precision: null,
              numeric_scale: null,
              ordinal_position: 2,
              column_comment: null,
            },
          ],
        } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              table_name: 'users',
              constraint_name: 'users_pkey',
              constraint_type: 'PRIMARY KEY',
              column_name: 'id',
              foreign_table_name: null,
              foreign_column_name: null,
            },
          ],
        } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              tablename: 'users',
              indexname: 'users_pkey',
              indexdef: 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)',
            },
          ],
        } as any);

      const request = new Request('https://example.com/api/admin/schema');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tables).toHaveLength(1);
      expect(body.tables[0].name).toBe('users');
      expect(body.tables[0].columns).toHaveLength(2);
      expect(body.tables[0].columns[0]).toMatchObject({
        name: 'id',
        type: 'character varying',
        nullable: false,
      });
      expect(body.tables[0].constraints).toHaveLength(1);
      expect(body.tables[0].constraints[0].type).toBe('PRIMARY KEY');
      expect(body.tables[0].indexes).toHaveLength(1);
    });

    it('should run 4 parallel queries', async () => {
      const request = new Request('https://example.com/api/admin/schema');
      await GET(request);

      expect(db.execute).toHaveBeenCalledTimes(4);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.execute).mockReset().mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/admin/schema');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch schema data');
    });

    it('should log error when query fails', async () => {
      const error = new Error('Query failed');
      vi.mocked(db.execute).mockReset().mockRejectedValue(error);

      const request = new Request('https://example.com/api/admin/schema');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching schema:', error);
    });
  });
});
