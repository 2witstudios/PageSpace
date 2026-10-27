import { describe, it, expect, vi } from 'vitest';
import {
  ANALYTICS_TABLE_DDL,
  ensureAnalyticsTables,
} from '../clickhouse-ddl';
import { ANALYTICS_TABLES } from '../analytics-rows';

const ddlFor = (table: string): string => {
  const entry = ANALYTICS_TABLE_DDL.find((d) => d.table === table);
  if (!entry) throw new Error(`no DDL for table ${table}`);
  return entry.ddl;
};

// Collapse whitespace so clause assertions are formatting-independent.
const flat = (ddl: string): string => ddl.replace(/\s+/g, ' ');

describe('ANALYTICS_TABLE_DDL — MergeTree schema per design ref lkjmhbmjekgbntk2z4rsjzw2 (#890 Phase 3)', () => {
  it('given the DDL set, should define exactly the 4 analytics tables', () => {
    expect(ANALYTICS_TABLE_DDL.map((d) => d.table).sort()).toEqual(
      ['api_metrics', 'error_logs', 'system_logs', 'user_activities'],
    );
    expect(Object.values(ANALYTICS_TABLES).sort()).toEqual(
      ['api_metrics', 'error_logs', 'system_logs', 'user_activities'],
    );
  });

  it('given any table, should be idempotent (CREATE TABLE IF NOT EXISTS) and partitioned by toYYYYMM(timestamp)', () => {
    for (const { table, ddl } of ANALYTICS_TABLE_DDL) {
      expect(flat(ddl)).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(flat(ddl)).toContain('ENGINE = MergeTree');
      expect(flat(ddl)).toContain('PARTITION BY toYYYYMM(timestamp)');
    }
  });

  describe('api_metrics', () => {
    it('given the hot path, should ORDER BY (timestamp, endpoint, status_code)', () => {
      expect(flat(ddlFor('api_metrics'))).toContain('ORDER BY (timestamp, endpoint, status_code)');
    });

    it('given bounded string columns, should mark endpoint and method LowCardinality', () => {
      const ddl = flat(ddlFor('api_metrics'));
      expect(ddl).toContain('`endpoint` LowCardinality(String)');
      expect(ddl).toContain('`method` LowCardinality(String)');
    });

    it('given 90d retention, should carry a 90 DAY TTL on timestamp', () => {
      expect(flat(ddlFor('api_metrics'))).toContain('TTL toDateTime(timestamp) + INTERVAL 90 DAY');
    });
  });

  describe('system_logs', () => {
    it('given the hot path, should ORDER BY (timestamp, level, category)', () => {
      expect(flat(ddlFor('system_logs'))).toContain('ORDER BY (timestamp, level, category)');
    });

    it('given bounded string columns, should mark level and category LowCardinality', () => {
      const ddl = flat(ddlFor('system_logs'));
      expect(ddl).toContain('`level` LowCardinality(String)');
      // category is an ORDER BY key so it cannot be Nullable — PG NULL maps to ''.
      expect(ddl).toContain("`category` LowCardinality(String) DEFAULT ''");
    });

    it('given 30d retention, should carry a 30 DAY TTL on timestamp', () => {
      expect(flat(ddlFor('system_logs'))).toContain('TTL toDateTime(timestamp) + INTERVAL 30 DAY');
    });
  });

  describe('user_activities', () => {
    it('given the per-user hot path, should ORDER BY (user_id, timestamp, action)', () => {
      expect(flat(ddlFor('user_activities'))).toContain('ORDER BY (user_id, timestamp, action)');
    });

    it('given bounded string columns, should mark action LowCardinality', () => {
      expect(flat(ddlFor('user_activities'))).toContain('`action` LowCardinality(String)');
    });

    it('given 180d retention, should carry a 180 DAY TTL on timestamp', () => {
      expect(flat(ddlFor('user_activities'))).toContain('TTL toDateTime(timestamp) + INTERVAL 180 DAY');
    });
  });

  describe('error_logs', () => {
    it('given the hot path, should ORDER BY (timestamp, name)', () => {
      expect(flat(ddlFor('error_logs'))).toContain('ORDER BY (timestamp, name)');
    });

    it('given bounded error names, should mark name LowCardinality', () => {
      expect(flat(ddlFor('error_logs'))).toContain('`name` LowCardinality(String)');
    });

    it('given the no-retention rule, should carry NO TTL', () => {
      expect(flat(ddlFor('error_logs'))).not.toContain('TTL ');
    });

    it('given CH rows are immutable, should NOT mirror the mutable PG resolution workflow columns', () => {
      const ddl = flat(ddlFor('error_logs'));
      // resolved/resolved_at/resolved_by/resolution live in a main-PG mini-table (leaf 3).
      expect(ddl).not.toContain('resolved');
      expect(ddl).not.toContain('resolution');
    });
  });

  it('given timestamps, should use DateTime64(3, UTC) everywhere', () => {
    for (const { ddl } of ANALYTICS_TABLE_DDL) {
      expect(flat(ddl)).toContain("`timestamp` DateTime64(3, 'UTC')");
    }
  });
});

describe('ensureAnalyticsTables — idempotent bootstrap shell', () => {
  it('given a client, should run every table DDL through client.command', async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    await ensureAnalyticsTables({ command });

    expect(command).toHaveBeenCalledTimes(ANALYTICS_TABLE_DDL.length);
    const queries = command.mock.calls.map((c) => (c[0] as { query: string }).query);
    expect(queries).toEqual(ANALYTICS_TABLE_DDL.map((d) => d.ddl));
  });

  it('given a failing DDL, should propagate the error (migrations fail loudly, unlike inserts)', async () => {
    const command = vi.fn().mockRejectedValue(new Error('DDL rejected'));
    await expect(ensureAnalyticsTables({ command })).rejects.toThrow('DDL rejected');
  });
});
