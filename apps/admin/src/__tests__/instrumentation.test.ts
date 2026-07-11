import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// #890 Phase 3 FIX: admin is a ClickHouse composition root too (its
// monitoring readers and logger-database writers run in this process) —
// a half-configured deploy must crash at boot, and graceful shutdown must
// drain the CH insert buffers. Draining + termination is owned by the shared
// logger's flush → drain → exit handler, which register() initializes; the
// composition root registers no bespoke signal listener.

vi.mock('@pagespace/lib/observability/clickhouse-client', () => ({
  probeClickHouseStartup: vi.fn(() => ({ mode: 'disabled', reason: 'flag off' })),
}));
// Mocked so register()'s init import does not construct the real logger
// singleton (which would register real signal handlers + a flush timer on the
// test process). Its shutdown-owner behavior is covered by
// packages/lib graceful-shutdown.test.ts.
vi.mock('@pagespace/lib/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { register } from '../instrumentation';
import { probeClickHouseStartup } from '@pagespace/lib/observability/clickhouse-client';

describe('admin instrumentation — ClickHouse composition-root wiring (#890 Phase 3 FIX)', () => {
  let onSpy: MockInstance;

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

  it('given nodejs startup, register() should NOT register a bespoke SIGTERM/SIGINT listener — graceful shutdown (flush → drain → exit) is owned by the shared logger, which register() initializes', async () => {
    await register();

    const signalListeners = onSpy.mock.calls.filter(
      ([event]) => event === 'SIGTERM' || event === 'SIGINT',
    );
    expect(signalListeners).toHaveLength(0);
  });

  it('given the edge runtime, register() should not touch the ClickHouse wiring', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');

    await register();

    expect(probeClickHouseStartup).not.toHaveBeenCalled();
  });
});
