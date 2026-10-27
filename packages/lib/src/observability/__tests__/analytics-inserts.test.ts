import { describe, it, expect, vi } from 'vitest';
import {
  createAnalyticsInserters,
  type AnalyticsInsertClient,
} from '../analytics-inserts';
import { ClickHouseMisconfiguredError } from '../clickhouse-env';

const assignedDeps = {
  createId: () => 'fixed-id',
  now: () => new Date('2026-07-10T08:30:15.123Z'),
};

const makeClient = (): { client: AnalyticsInsertClient; insert: ReturnType<typeof vi.fn> } => {
  const insert = vi.fn().mockResolvedValue(undefined);
  return { client: { insert }, insert };
};

describe('createAnalyticsInserters — pure (row) → void adapters over the buffer (#890 Phase 3)', () => {
  it('given an api metric, insertApiMetric should buffer a mapped CH row and flush it as JSONEachRow', async () => {
    const { client, insert } = makeClient();
    const inserters = createAnalyticsInserters({ getClient: () => client, ...assignedDeps });

    inserters.insertApiMetric({ endpoint: '/api/x', method: 'GET', statusCode: 200, duration: 42 });
    await inserters.flush();

    expect(insert).toHaveBeenCalledTimes(1);
    const params = insert.mock.calls[0][0] as {
      table: string;
      values: Array<Record<string, unknown>>;
      format: string;
    };
    expect(params.table).toBe('api_metrics');
    expect(params.format).toBe('JSONEachRow');
    expect(params.values[0]).toMatchObject({
      id: 'fixed-id',
      timestamp: '2026-07-10 08:30:15.123',
      endpoint: '/api/x',
      status_code: 200,
    });
  });

  it('given each adapter, should route to its own table', async () => {
    const { client, insert } = makeClient();
    const inserters = createAnalyticsInserters({ getClient: () => client, ...assignedDeps });

    inserters.insertApiMetric({ endpoint: '/e', method: 'GET', statusCode: 200, duration: 1 });
    inserters.insertSystemLog({ level: 'info', message: 'm' });
    inserters.insertUserActivity({ userId: 'u-1', action: 'a' });
    inserters.insertError({ name: 'E', message: 'm' });
    await inserters.flush();

    const tables = insert.mock.calls.map((c) => (c[0] as { table: string }).table).sort();
    expect(tables).toEqual(['api_metrics', 'error_logs', 'system_logs', 'user_activities']);
  });

  it('given a caller-provided id and timestamp, should use them instead of generating', async () => {
    const { client, insert } = makeClient();
    const inserters = createAnalyticsInserters({ getClient: () => client, ...assignedDeps });

    inserters.insertApiMetric({
      id: 'caller-id',
      timestamp: new Date('2025-01-01T00:00:00.000Z'),
      endpoint: '/e',
      method: 'GET',
      statusCode: 200,
      duration: 1,
    });
    await inserters.flush();

    const params = insert.mock.calls[0][0] as { values: Array<Record<string, unknown>> };
    expect(params.values[0].id).toBe('caller-id');
    expect(params.values[0].timestamp).toBe('2025-01-01 00:00:00.000');
  });

  it('given rows below maxRows, should batch through the buffer (single flush, one insert call)', async () => {
    const { client, insert } = makeClient();
    const inserters = createAnalyticsInserters({ getClient: () => client, ...assignedDeps });

    inserters.insertSystemLog({ level: 'info', message: 'one' });
    inserters.insertSystemLog({ level: 'info', message: 'two' });
    inserters.insertSystemLog({ level: 'info', message: 'three' });
    await inserters.flush();

    expect(insert).toHaveBeenCalledTimes(1);
    const params = insert.mock.calls[0][0] as { values: unknown[] };
    expect(params.values).toHaveLength(3);
  });

  describe('never-throw contract', () => {
    it('given getClient returns null (tier off), adapters should be silent no-ops', async () => {
      const inserters = createAnalyticsInserters({ getClient: () => null, ...assignedDeps });

      expect(() => inserters.insertApiMetric({ endpoint: '/e', method: 'GET', statusCode: 200, duration: 1 })).not.toThrow();
      expect(() => inserters.insertSystemLog({ level: 'info', message: 'm' })).not.toThrow();
      expect(() => inserters.insertUserActivity({ userId: 'u', action: 'a' })).not.toThrow();
      expect(() => inserters.insertError({ name: 'E', message: 'm' })).not.toThrow();
      await expect(inserters.flush()).resolves.toBeUndefined();
    });

    it('given getClient throws (misconfigured), adapters should absorb and log payload-free', () => {
      const logError = vi.fn();
      const inserters = createAnalyticsInserters({
        getClient: () => {
          throw new Error('ClickHouse client init failed: CLICKHOUSE_USER is not set');
        },
        logError,
        ...assignedDeps,
      });

      expect(() =>
        inserters.insertSystemLog({ level: 'error', message: 'SECRET-PAYLOAD', userId: 'SECRET-USER' }),
      ).not.toThrow();
      expect(logError).toHaveBeenCalledTimes(1);
      const logged = logError.mock.calls[0][0] as string;
      expect(logged).toContain('system_logs');
      expect(logged).not.toContain('SECRET-PAYLOAD');
      expect(logged).not.toContain('SECRET-USER');
    });

    it('given a client whose insert rejects, flush should absorb the failure and never log row payloads', async () => {
      const logError = vi.fn();
      const insert = vi.fn().mockRejectedValue(new Error('network down'));
      const inserters = createAnalyticsInserters({
        getClient: () => ({ insert }),
        logError,
        ...assignedDeps,
      });

      inserters.insertError({ name: 'E', message: 'SECRET-ERROR-DETAIL' });
      await expect(inserters.flush()).resolves.toBeUndefined();

      expect(logError).toHaveBeenCalled();
      const allLogged = logError.mock.calls.flat().join(' ');
      expect(allLogged).toContain('error_logs');
      expect(allLogged).not.toContain('SECRET-ERROR-DETAIL');
    });

    it('given getClient throws ClickHouseMisconfiguredError, the log message should name the misconfiguration — NOT read as a transient drop (#890 Phase 3 FIX)', () => {
      const logError = vi.fn();
      const inserters = createAnalyticsInserters({
        getClient: () => {
          throw new ClickHouseMisconfiguredError(
            "CLICKHOUSE_ENABLED='true' but CLICKHOUSE_PASSWORD is not set.",
          );
        },
        logError,
        ...assignedDeps,
      });

      inserters.insertSystemLog({ level: 'error', message: 'SECRET-PAYLOAD' });

      expect(logError).toHaveBeenCalledTimes(1);
      const logged = logError.mock.calls[0][0] as string;
      expect(logged).toMatch(/MISCONFIGURED/);
      expect(logged).toContain('system_logs');
      expect(logged).not.toContain('SECRET-PAYLOAD');
    });

    it('given unserializable metadata (circular), the adapter should drop the row without throwing', () => {
      const logError = vi.fn();
      const { client, insert } = makeClient();
      const inserters = createAnalyticsInserters({ getClient: () => client, logError, ...assignedDeps });

      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() =>
        inserters.insertUserActivity({ userId: 'u-1', action: 'a', metadata: circular }),
      ).not.toThrow();
      expect(insert).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError.mock.calls[0][0]).toContain('user_activities');
    });
  });

  it('given drain, should flush pending rows and await in-flight inserts', async () => {
    const { client, insert } = makeClient();
    const inserters = createAnalyticsInserters({ getClient: () => client, ...assignedDeps });

    inserters.insertUserActivity({ userId: 'u-1', action: 'a' });
    await inserters.drain();

    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('given the factory, should not touch the client until the first adapter call (lazy)', () => {
    const getClient = vi.fn().mockReturnValue(null);
    createAnalyticsInserters({ getClient, ...assignedDeps });
    expect(getClient).not.toHaveBeenCalled();
  });
});
