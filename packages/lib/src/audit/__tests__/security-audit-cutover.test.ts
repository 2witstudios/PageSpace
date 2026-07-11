/**
 * Runtime-cutover suite (#890 Phase 2, leaf 5).
 *
 * Pins the DEFAULT wiring of the securityAudit singleton after the bind:
 *
 *   dedicated   → logEvent routes through the lock-free ingest writer on the
 *                 Admin PG (ONE insert, no advisory lock, no transaction, no
 *                 head read) with the co-stream witness line.
 *   break-glass → the OLD advisory-lock chained append against the main DB,
 *                 plus loud observability at the bind point: structured
 *                 security error + real alert (security-audit-alerting
 *                 channel, source 'break_glass') + a self-recorded security
 *                 event — each exactly once per process.
 *   fail        → logEvent REJECTS (never throws synchronously) so the
 *                 fire-and-forget audit() wrapper degrades to a warn log.
 *
 * The 248 audit()/auditRequest() call sites are pinned by asserting the
 * securityAudit public surface is byte-for-byte the pre-cutover one and that
 * audit() still never throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { state, mockGetAdminDbMode, mockGetAdminDb, mockLoggers } = vi.hoisted(() => {
  const state = {
    adminInserts: [] as Array<Record<string, unknown>>,
    mainInserts: [] as Array<Record<string, unknown>>,
    mainExecutedSql: [] as Array<{ strings: TemplateStringsArray; values: unknown[] }>,
    adminInsertError: null as Error | null,
  };
  return {
    state,
    mockGetAdminDbMode: vi.fn(),
    mockGetAdminDb: vi.fn(),
    mockLoggers: {
      security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  };
});

const { adminDbMock, mainDbMock } = vi.hoisted(() => {
  const adminDbMock = {
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        if (state.adminInsertError) return Promise.reject(state.adminInsertError);
        state.adminInserts.push(values);
        return Promise.resolve(undefined);
      },
    })),
    transaction: vi.fn(),
    execute: vi.fn(),
    select: vi.fn(),
  };

  const mainTx = {
    execute: (sqlObj: { strings: TemplateStringsArray; values: unknown[] }) => {
      state.mainExecutedSql.push(sqlObj);
      return Promise.resolve({ rows: [] });
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        state.mainInserts.push(values);
        return Promise.resolve(undefined);
      },
    }),
  };
  const mainDbMock = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: vi.fn(async (callback: any) => callback(mainTx)),
    insert: vi.fn(),
    execute: vi.fn(),
    select: vi.fn(),
  };
  return { adminDbMock, mainDbMock };
});

vi.mock('@pagespace/db/admin-db', () => ({
  getAdminDb: mockGetAdminDb,
  getAdminDbMode: mockGetAdminDbMode,
}));
vi.mock('@pagespace/db/db', () => ({ db: mainDbMock }));
vi.mock('@pagespace/db/schema/security-audit', () => ({ securityAuditLog: {} }));
vi.mock('@pagespace/db/admin-schema', () => ({ securityAuditIngest: {} }));
vi.mock('@pagespace/db/operators', () => ({
  desc: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  eq: vi.fn(),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock('../../logging/logger-config', () => ({ loggers: mockLoggers }));

async function loadFreshModules() {
  vi.resetModules();
  const securityAuditModule = await import('../security-audit');
  const alerting = await import('../security-audit-alerting');
  const auditLog = await import('../audit-log');
  return { securityAuditModule, alerting, auditLog };
}

const lockSqlSeen = () =>
  state.mainExecutedSql.filter((s) => s.strings.join('').includes('pg_advisory_xact_lock'));

describe('securityAudit default wiring cutover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.adminInserts.length = 0;
    state.mainInserts.length = 0;
    state.mainExecutedSql.length = 0;
    state.adminInsertError = null;
    mockGetAdminDb.mockReturnValue(adminDbMock);
  });

  afterEach(async () => {
    // Never leak a registered alert handler into another suite.
    const alerting = await import('../security-audit-alerting');
    alerting.setChainAlertHandler(null);
  });

  describe('dedicated mode (Admin PG configured)', () => {
    beforeEach(() => {
      mockGetAdminDbMode.mockReturnValue({ mode: 'dedicated', reason: 'ADMIN_DATABASE_URL is set' });
    });

    it('given logEvent, should perform exactly ONE ingest insert on the Admin PG with the emission hash', async () => {
      const { securityAuditModule } = await loadFreshModules();

      await securityAuditModule.securityAudit.logEvent({
        eventType: 'auth.login.success',
        userId: 'user-1',
        ipAddress: '1.2.3.4',
      });

      expect(state.adminInserts).toHaveLength(1);
      expect(state.adminInserts[0]).toMatchObject({
        eventType: 'auth.login.success',
        userId: 'user-1',
      });
      expect(state.adminInserts[0]!.emissionHash).toMatch(/^[0-9a-f]{64}$/);
      expect(state.adminInserts[0]!.id).toEqual(expect.any(String));
    });

    it('given logEvent, should be LOCK-FREE on the request path — no advisory lock, no transaction, no head read, main db untouched', async () => {
      const { securityAuditModule } = await loadFreshModules();

      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.read', userId: 'u' });

      expect(lockSqlSeen()).toHaveLength(0);
      expect(adminDbMock.transaction).not.toHaveBeenCalled();
      expect(adminDbMock.execute).not.toHaveBeenCalled();
      expect(adminDbMock.select).not.toHaveBeenCalled();
      expect(mainDbMock.transaction).not.toHaveBeenCalled();
      expect(mainDbMock.insert).not.toHaveBeenCalled();
    });

    it('given logEvent, should emit the co-stream witness line after the insert', async () => {
      const { securityAuditModule } = await loadFreshModules();

      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.write', userId: 'u' });

      expect(mockLoggers.security.info).toHaveBeenCalledWith(
        'security_audit.costream',
        expect.objectContaining({
          eventType: 'data.write',
          emissionHash: state.adminInserts[0]!.emissionHash,
          eventId: state.adminInserts[0]!.id,
        }),
      );
    });

    it('given a convenience wrapper (logAuthSuccess), should route through the same ingest path', async () => {
      const { securityAuditModule } = await loadFreshModules();

      await securityAuditModule.securityAudit.logAuthSuccess('u1', 's1', '9.9.9.9', 'UA');

      expect(state.adminInserts).toHaveLength(1);
      expect(state.adminInserts[0]).toMatchObject({ eventType: 'auth.login.success', userId: 'u1' });
      expect(lockSqlSeen()).toHaveLength(0);
    });

    it('given the ingest insert fails, audit() should stay fire-and-forget (warn log, no throw)', async () => {
      const { auditLog } = await loadFreshModules();
      state.adminInsertError = new Error('admin pg down');

      expect(() =>
        auditLog.audit({ eventType: 'auth.login.failure', ipAddress: '1.1.1.1' }),
      ).not.toThrow();

      await vi.waitFor(() => {
        expect(mockLoggers.security.warn).toHaveBeenCalledWith(
          expect.stringContaining('audit write failed'),
          expect.objectContaining({ error: expect.any(Error) }),
        );
      });
    });

    it('should keep the securityAudit public surface identical (zero-call-site contract)', async () => {
      const { securityAuditModule } = await loadFreshModules();
      expect(Object.keys(securityAuditModule.securityAudit).sort()).toEqual(
        [
          'initialize',
          'isInitialized',
          'logAccessDenied',
          'logAnomalyDetected',
          'logAuthFailure',
          'logAuthSuccess',
          'logBruteForceDetected',
          'logDataAccess',
          'logEvent',
          'logLogout',
          'logRateLimited',
          'logTokenCreated',
          'logTokenRevoked',
          'queryEvents',
        ].sort(),
      );
    });
  });

  describe('break-glass mode (ADMIN_DB_BREAK_GLASS armed)', () => {
    beforeEach(() => {
      mockGetAdminDbMode.mockReturnValue({ mode: 'break-glass', reason: 'flag armed' });
    });

    it('given logEvent, should use the OLD advisory-lock chained append against the MAIN db', async () => {
      const { securityAuditModule } = await loadFreshModules();

      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.read', userId: 'u' });
      await vi.waitFor(() => expect(state.mainInserts.length).toBeGreaterThanOrEqual(2));

      // Advisory lock taken for each append (the pre-cutover semantics).
      expect(lockSqlSeen().length).toBeGreaterThanOrEqual(2);
      const eventTypes = state.mainInserts.map((v) => v.eventType);
      expect(eventTypes).toContain('data.read');
      // The Admin PG is never touched.
      expect(mockGetAdminDb).not.toHaveBeenCalled();
      expect(state.adminInserts).toHaveLength(0);
    });

    it('should self-record ONE break-glass security event in the degraded chain', async () => {
      const { securityAuditModule } = await loadFreshModules();

      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.read', userId: 'u' });
      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.write', userId: 'u' });

      await vi.waitFor(() => {
        const breakGlassEvents = state.mainInserts.filter(
          (v) =>
            v.eventType === 'security.suspicious.activity' &&
            Array.isArray(v.anomalyFlags) &&
            (v.anomalyFlags as string[]).includes('admin_db_break_glass'),
        );
        expect(breakGlassEvents).toHaveLength(1);
        expect(breakGlassEvents[0]!.details).toMatchObject({ breakGlass: true, reason: 'flag armed' });
      });
    });

    it('should fire a REAL alert through the security-audit-alerting channel (source break_glass), once per process', async () => {
      const { securityAuditModule, alerting } = await loadFreshModules();
      const handler = vi.fn();
      alerting.setChainAlertHandler(handler);

      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.read', userId: 'u' });
      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.write', userId: 'u' });

      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      const alert = handler.mock.calls[0]![0];
      expect(alert.source).toBe('break_glass');
      expect(alert.result.isValid).toBe(false);
      expect(alert.result.breakPoint.description).toContain('ADMIN_DATABASE_URL');
      expect(alert.result.breakPoint.description).toContain('MAIN application database');
    });

    it('should log the structured security banner exactly once per process', async () => {
      const { securityAuditModule } = await loadFreshModules();

      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.read', userId: 'u' });
      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.write', userId: 'u' });

      const banners = mockLoggers.security.error.mock.calls.filter(([msg]) =>
        String(msg).includes('BREAK-GLASS'),
      );
      expect(banners).toHaveLength(1);
      expect(banners[0]![1]).toMatchObject({ reason: 'flag armed' });
    });
  });

  describe('main-db mode (unconfigured trust plane — THE incident fix: silent, working)', () => {
    beforeEach(() => {
      mockGetAdminDbMode.mockReturnValue({ mode: 'main-db', reason: 'main db default' });
    });

    it('given logEvent, should use the advisory-lock chained append against the MAIN db (audit writes SUCCEED)', async () => {
      const { securityAuditModule } = await loadFreshModules();

      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.read', userId: 'u' });
      await vi.waitFor(() => expect(state.mainInserts.length).toBeGreaterThanOrEqual(1));

      expect(lockSqlSeen().length).toBeGreaterThanOrEqual(1);
      expect(state.mainInserts.map((v) => v.eventType)).toContain('data.read');
      // The Admin PG is never touched.
      expect(mockGetAdminDb).not.toHaveBeenCalled();
      expect(state.adminInserts).toHaveLength(0);
    });

    it('should NOT self-record any break-glass security event (silent operation)', async () => {
      const { securityAuditModule } = await loadFreshModules();

      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.read', userId: 'u' });
      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.write', userId: 'u' });
      await vi.waitFor(() => expect(state.mainInserts.length).toBeGreaterThanOrEqual(2));

      const breakGlassEvents = state.mainInserts.filter(
        (v) =>
          Array.isArray(v.anomalyFlags) &&
          (v.anomalyFlags as string[]).includes('admin_db_break_glass'),
      );
      expect(breakGlassEvents).toHaveLength(0);
    });

    it('should NOT fire any alert through the security-audit-alerting channel', async () => {
      const { securityAuditModule, alerting } = await loadFreshModules();
      const handler = vi.fn();
      alerting.setChainAlertHandler(handler);

      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.read', userId: 'u' });
      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.write', userId: 'u' });
      await vi.waitFor(() => expect(state.mainInserts.length).toBeGreaterThanOrEqual(2));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should NOT log the break-glass banner (no BREAK-GLASS security error)', async () => {
      const { securityAuditModule } = await loadFreshModules();

      await securityAuditModule.securityAudit.logEvent({ eventType: 'data.read', userId: 'u' });
      await vi.waitFor(() => expect(state.mainInserts.length).toBeGreaterThanOrEqual(1));

      const banners = mockLoggers.security.error.mock.calls.filter(([msg]) =>
        String(msg).includes('BREAK-GLASS'),
      );
      expect(banners).toHaveLength(0);
    });
  });

  describe('fail mode (trust plane declared required but unconfigured)', () => {
    beforeEach(() => {
      mockGetAdminDbMode.mockReturnValue({
        mode: 'fail',
        reason: "AUDIT_TRUST_PLANE_REQUIRED='true' but ADMIN_DATABASE_URL is not set.",
      });
    });

    it('given logEvent, should REJECT (not throw synchronously) with the actionable reason', async () => {
      const { securityAuditModule } = await loadFreshModules();

      let promise: Promise<void> | undefined;
      expect(() => {
        promise = securityAuditModule.securityAudit.logEvent({ eventType: 'data.read' });
      }).not.toThrow();
      await expect(promise).rejects.toThrow(/ADMIN_DATABASE_URL/);
    });

    it('given audit(), should stay fire-and-forget — the rejection surfaces as a warn log', async () => {
      const { auditLog } = await loadFreshModules();

      expect(() => auditLog.audit({ eventType: 'data.read', userId: 'u' })).not.toThrow();

      await vi.waitFor(() => {
        expect(mockLoggers.security.warn).toHaveBeenCalledWith(
          expect.stringContaining('audit write failed'),
          expect.objectContaining({ error: expect.any(Error) }),
        );
      });
    });

    it('initialize/isInitialized remain synchronous and safe (no binding resolution)', async () => {
      const { securityAuditModule } = await loadFreshModules();
      await expect(securityAuditModule.securityAudit.initialize()).resolves.toBeUndefined();
      expect(securityAuditModule.securityAudit.isInitialized()).toBe(true);
    });
  });
});
