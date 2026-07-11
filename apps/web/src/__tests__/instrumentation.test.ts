import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// #890 Phase 3 FIX: the composition root must (1) crash a half-configured
// deploy at startup — flag on + creds missing would otherwise silently black
// out all 4 analytics tables while enqueue() absorbs per-row errors — and
// (2) initialize the shared logger so its flush → drain → exit shutdown
// handler (the single, terminating owner of graceful shutdown) is installed
// at boot, draining the CH insert buffers on SIGTERM/SIGINT. The composition
// root itself registers no bespoke signal listener.

vi.mock('@sentry/nextjs', () => ({ captureRequestError: vi.fn() }));
vi.mock('../../sentry.server.config', () => ({}));
vi.mock('@pagespace/lib/config/env-validation', () => ({ validateEnv: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  setActivityBroadcastHook: vi.fn(),
}));
vi.mock('@/lib/websocket/socket-utils', () => ({ broadcastActivityEvent: vi.fn() }));
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

describe('web instrumentation — ClickHouse composition-root wiring (#890 Phase 3 FIX)', () => {
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

  it('given nodejs startup, register() should probe the ClickHouse mode (fail-fast on misconfiguration)', async () => {
    await register();

    expect(probeClickHouseStartup).toHaveBeenCalled();
  });

  it('given a misconfigured deploy, register() should REJECT so the server crashes at boot instead of silently dropping telemetry', async () => {
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

    await register().catch(() => {
      // edge branch imports sentry.edge.config which is unmocked; the only
      // assertion that matters is that no CH wiring ran.
    });

    expect(probeClickHouseStartup).not.toHaveBeenCalled();
  });
});
