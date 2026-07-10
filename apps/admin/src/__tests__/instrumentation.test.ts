import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #890 Phase 3 FIX: admin is a ClickHouse composition root too (its
// monitoring readers and logger-database writers run in this process) —
// a half-configured deploy must crash at boot, and SIGTERM/SIGINT must
// drain the CH insert buffers.

vi.mock('@pagespace/lib/observability/clickhouse-client', () => ({
  probeClickHouseStartup: vi.fn(() => ({ mode: 'disabled', reason: 'flag off' })),
}));
vi.mock('@pagespace/lib/observability/analytics-inserts', () => ({
  drainAnalyticsInserts: vi.fn(() => Promise.resolve()),
}));

import { register } from '../instrumentation';
import { probeClickHouseStartup } from '@pagespace/lib/observability/clickhouse-client';
import { drainAnalyticsInserts } from '@pagespace/lib/observability/analytics-inserts';

describe('admin instrumentation — ClickHouse composition-root wiring (#890 Phase 3 FIX)', () => {
  let onSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(probeClickHouseStartup).mockImplementation(() => ({
      mode: 'disabled',
      reason: 'flag off',
    }));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    onSpy = vi.spyOn(process, 'on');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    onSpy.mockRestore();
  });

  it('given nodejs startup, register() should probe the ClickHouse mode', async () => {
    await register();

    expect(probeClickHouseStartup).toHaveBeenCalled();
  });

  it('given a misconfigured deploy, register() should REJECT so the server crashes at boot', async () => {
    vi.mocked(probeClickHouseStartup).mockImplementation(() => {
      throw new Error('ClickHouse misconfigured: startup probe failed');
    });

    await expect(register()).rejects.toThrow('ClickHouse misconfigured');
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'given %s, the registered handler should drain the analytics insert buffers',
    async (signal) => {
      await register();

      const handlers = onSpy.mock.calls
        .filter(([event]) => event === signal)
        .map(([, handler]) => handler as () => unknown);
      expect(handlers.length).toBeGreaterThan(0);

      for (const handler of handlers) await handler();

      expect(drainAnalyticsInserts).toHaveBeenCalled();
    },
  );

  it('given the edge runtime, register() should not touch the ClickHouse wiring', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');

    await register();

    expect(probeClickHouseStartup).not.toHaveBeenCalled();
  });
});
