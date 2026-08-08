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

// Admin is also a security-audit alert composition root: `alertHandler` in
// security-audit-alerting.ts is process-local, and this process calls audit()
// from ~19 routes (audit() → securityAudit.logEvent() → the break-glass bind
// point → notifyAdminDbBreakGlass). Mocked here so the registration can be
// captured and the registered handler invoked for real.
const { mockSetChainAlertHandler, mockCaptureException } = vi.hoisted(() => ({
  mockSetChainAlertHandler: vi.fn(),
  mockCaptureException: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/security-audit-alerting', () => ({
  setChainAlertHandler: mockSetChainAlertHandler,
}));

// `init` is required as well as `captureException`: register() imports
// sentry.server.config / sentry.edge.config, and both call Sentry.init at module
// scope, so a mock missing it fails every test in this file rather than only the
// new ones.
vi.mock('@sentry/nextjs', () => ({
  init: vi.fn(),
  captureException: mockCaptureException,
  captureRequestError: vi.fn(),
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

describe('admin instrumentation — security-audit alert composition-root wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(probeClickHouseStartup).mockImplementation(() => ({
      mode: 'disabled',
      reason: 'flag off',
    }));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('given nodejs startup, register() should register a chain alert handler — without one, every notify* helper in this process is a silent no-op', async () => {
    await register();

    expect(mockSetChainAlertHandler).toHaveBeenCalledTimes(1);
    expect(typeof mockSetChainAlertHandler.mock.calls[0][0]).toBe('function');
  });

  it('given a registered handler, invoking it should capture to Sentry tagged as the admin process', async () => {
    await register();
    const handler = mockSetChainAlertHandler.mock.calls[0][0];

    const now = new Date('2026-08-08T02:00:00.000Z');
    handler({
      source: 'break_glass',
      triggeredAt: now,
      result: {
        isValid: false,
        totalEntries: 0,
        entriesVerified: 0,
        validEntries: 0,
        invalidEntries: 0,
        breakPoint: {
          entryId: 'admin-db-break-glass',
          timestamp: now,
          position: 0,
          storedHash: '',
          computedHash: '',
          previousHashUsed: '',
          description: 'Admin DB break-glass is ACTIVE',
        },
        firstEntryId: null,
        lastEntryId: null,
        verificationStartedAt: now,
        verificationCompletedAt: now,
        durationMs: 0,
      },
    });

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [error, context] = mockCaptureException.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Admin DB break-glass is ACTIVE');
    expect(context.level).toBe('fatal');
    expect(context.tags.process).toBe('admin');
    // Same grouping key as the other processes, so one fault is one issue.
    expect(context.fingerprint).toEqual(['security-audit-chain', 'break_glass']);
  });

  it('given the edge runtime, register() should not register the handler', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');

    await register();

    expect(mockSetChainAlertHandler).not.toHaveBeenCalled();
  });
});
