/**
 * Unit tests for the pure core of scripts/backfill-audit-db.ts (#890 Phase 2,
 * leaf 8 — backfill + flip + freeze).
 *
 * Everything here is pure decision logic: precondition assessment (the
 * era-boundary crux — a chainer that already chained from 'genesis' before
 * legacy rows were planted is an unrecoverable-in-place state and MUST abort),
 * sequence alignment planning, SIEM anchor-row resolution (leaf 7's
 * anchor-committed-last invariant), historical partition month planning,
 * post-plant parity assessment, CLI/env resolution, and the freeze-guard SQL
 * builder whose mutable-column allowlist must stay in lockstep with the GDPR
 * pseudonymization patch. The imperative shells are covered by
 * backfill-audit-db.integration.test.ts on scratch Postgres.
 */
import { describe, it, expect } from 'vitest';
import {
  readCursorId,
  assessBackfillPreconditions,
  planSequenceTarget,
  resolveAnchorRowId,
  monthPartitionsForRange,
  assessBackfillParity,
  resolveBackfillCliMode,
  resolveBackfillEnv,
  buildFreezeGuardFunctionSql,
  ERASER_MUTABLE_COLUMNS,
  FROZEN_IMMUTABLE_COLUMNS,
  SIEM_CURSOR_INIT_SENTINEL,
  CHAINER_ADVISORY_LOCK_KEY,
  type BackfillStoreState,
} from '../backfill-audit-db';
import { buildSecurityAuditPseudonymizationPatch } from '@pagespace/lib/compliance/erasure/pseudonymize';

const baseState: BackfillStoreState = {
  breakGlassArmed: false,
  mainCount: 5,
  mainMaxSeq: 5,
  mainHeadHash: 'head-5',
  adminLegacyCount: 0,
  adminEmission: null,
};

describe('assessBackfillPreconditions', () => {
  it('given break-glass armed, should refuse regardless of store state', () => {
    const result = assessBackfillPreconditions({ ...baseState, breakGlassArmed: true });
    expect(result).toMatchObject({ ok: false, reason: 'break_glass_armed' });
  });

  it('given an empty main table, should proceed as a no-op (nothing to backfill)', () => {
    const result = assessBackfillPreconditions({
      ...baseState,
      mainCount: 0,
      mainMaxSeq: 0,
      mainHeadHash: null,
    });
    expect(result).toEqual({ ok: true, state: 'empty_main' });
  });

  it('given no emission-era rows in admin, should proceed (clean pre-chainer state)', () => {
    const result = assessBackfillPreconditions(baseState);
    expect(result).toEqual({ ok: true, state: 'pre_chainer' });
  });

  it('given emission-era rows chained from genesis while main has history, should ABORT unlinked_emission_era', () => {
    // The leaf-7 unresolved case: the chainer ran BEFORE backfill, so the
    // emission era grew from 'genesis' and can never link onto the legacy
    // head — nobody holds UPDATE on chain columns, so re-linking in place is
    // impossible by design. The only correct move is refusal + runbook.
    const result = assessBackfillPreconditions({
      ...baseState,
      adminEmission: { count: 3, minSeq: 1, earliestPrevHash: 'genesis' },
    });
    expect(result).toMatchObject({ ok: false, reason: 'unlinked_emission_era' });
  });

  it('given an emission era already linked onto the main head, should proceed (idempotent rerun)', () => {
    const result = assessBackfillPreconditions({
      ...baseState,
      adminLegacyCount: 5,
      adminEmission: { count: 2, minSeq: 6, earliestPrevHash: 'head-5' },
    });
    expect(result).toEqual({ ok: true, state: 'boundary_linked' });
  });

  it('given an emission era linked to neither genesis nor the main head, should ABORT boundary_mismatch', () => {
    // e.g. break-glass appended rows to main AFTER the era boundary froze —
    // the main head moved and the planted boundary no longer matches.
    const result = assessBackfillPreconditions({
      ...baseState,
      mainHeadHash: 'head-6-after-break-glass',
      mainMaxSeq: 6,
      mainCount: 6,
      adminLegacyCount: 5,
      adminEmission: { count: 2, minSeq: 6, earliestPrevHash: 'head-5' },
    });
    expect(result).toMatchObject({ ok: false, reason: 'boundary_mismatch' });
  });

  it('given a linked boundary whose emission seqs overlap legacy seqs, should ABORT seq_collision', () => {
    const result = assessBackfillPreconditions({
      ...baseState,
      adminLegacyCount: 4,
      adminEmission: { count: 2, minSeq: 5, earliestPrevHash: 'head-5' },
    });
    expect(result).toMatchObject({ ok: false, reason: 'seq_collision' });
  });
});

describe('planSequenceTarget', () => {
  it('given a planted legacy range, should target the max planted seq (nextval then exceeds it)', () => {
    expect(planSequenceTarget({ mainMaxSeq: 42, adminMaxSeq: 0 })).toBe(42);
  });

  it('given emission rows already beyond the legacy range, should never lower the sequence', () => {
    expect(planSequenceTarget({ mainMaxSeq: 42, adminMaxSeq: 44 })).toBe(44);
  });

  it('given nothing planted anywhere, should skip setval (setval(0) is invalid)', () => {
    expect(planSequenceTarget({ mainMaxSeq: 0, adminMaxSeq: 0 })).toBeNull();
  });
});

describe('resolveAnchorRowId', () => {
  it('given a seeded admin cursor, should anchor on its lastDeliveredId', () => {
    expect(resolveAnchorRowId({ adminCursorId: 'r3', mainCursorId: 'r2' })).toBe('r3');
  });

  it('given no admin cursor yet, should fall back to the legacy main cursor (the future seed value)', () => {
    expect(resolveAnchorRowId({ adminCursorId: null, mainCursorId: 'r2' })).toBe('r2');
  });

  it('given only sentinel cursors, should not gate on any anchor row', () => {
    expect(
      resolveAnchorRowId({
        adminCursorId: SIEM_CURSOR_INIT_SENTINEL,
        mainCursorId: SIEM_CURSOR_INIT_SENTINEL,
      })
    ).toBeNull();
    expect(resolveAnchorRowId({ adminCursorId: null, mainCursorId: null })).toBeNull();
  });

  it('given a sentinel admin cursor but a real main cursor, should anchor on the main watermark', () => {
    expect(
      resolveAnchorRowId({ adminCursorId: SIEM_CURSOR_INIT_SENTINEL, mainCursorId: 'r7' })
    ).toBe('r7');
  });
});

describe('monthPartitionsForRange', () => {
  it('given a multi-month legacy range, should plan one monthly partition per covered month', () => {
    const months = monthPartitionsForRange('2025-11-14 08:00:00', '2026-02-01 00:00:00');
    expect(months).toEqual([
      { name: 'security_audit_log_p2025_11', from: '2025-11-01', to: '2025-12-01' },
      { name: 'security_audit_log_p2025_12', from: '2025-12-01', to: '2026-01-01' },
      { name: 'security_audit_log_p2026_01', from: '2026-01-01', to: '2026-02-01' },
      { name: 'security_audit_log_p2026_02', from: '2026-02-01', to: '2026-03-01' },
    ]);
  });

  it('given a single-month range, should plan exactly that month', () => {
    expect(monthPartitionsForRange('2026-02-03 10:00:00', '2026-02-20 10:00:00')).toEqual([
      { name: 'security_audit_log_p2026_02', from: '2026-02-01', to: '2026-03-01' },
    ]);
  });

  it('given an absurd range, should throw rather than plan thousands of DDL statements', () => {
    expect(() => monthPartitionsForRange('1990-01-01 00:00:00', '2026-01-01 00:00:00')).toThrow(
      /range/i
    );
  });
});

describe('assessBackfillParity', () => {
  const good = {
    mainCount: 5,
    adminLegacyCount: 5,
    mainHeadHash: 'h5',
    adminLegacyHeadHash: 'h5',
    emissionBoundaryPrevHash: 'h5',
  };

  it('given counts, heads, and boundary all matching, should pass', () => {
    expect(assessBackfillParity(good)).toEqual({ ok: true, failures: [] });
  });

  it('given no emission era yet, should pass on counts + heads alone', () => {
    expect(assessBackfillParity({ ...good, emissionBoundaryPrevHash: null })).toEqual({
      ok: true,
      failures: [],
    });
  });

  it('given a row-count mismatch, should fail naming the counts', () => {
    const result = assessBackfillParity({ ...good, adminLegacyCount: 4 });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/count/i);
  });

  it('given a head-hash mismatch, should fail naming the heads', () => {
    const result = assessBackfillParity({ ...good, adminLegacyHeadHash: 'other' });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/head/i);
  });

  it('given an emission boundary that does not link off the legacy head, should fail', () => {
    const result = assessBackfillParity({ ...good, emissionBoundaryPrevHash: 'genesis' });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/boundary/i);
  });

  it('given an empty main store, should pass vacuously', () => {
    expect(
      assessBackfillParity({
        mainCount: 0,
        adminLegacyCount: 0,
        mainHeadHash: null,
        adminLegacyHeadHash: null,
        emissionBoundaryPrevHash: null,
      })
    ).toEqual({ ok: true, failures: [] });
  });
});

describe('resolveBackfillCliMode', () => {
  it('given no flags, should default to the dry-run plan', () => {
    expect(resolveBackfillCliMode([], {})).toEqual({ ok: true, command: 'plan' });
  });

  it('given --apply, should run the live backfill', () => {
    expect(resolveBackfillCliMode(['--apply'], {})).toEqual({ ok: true, command: 'apply' });
  });

  it('given --freeze without explicit confirmation, should refuse (freeze breaks break-glass appends)', () => {
    const result = resolveBackfillCliMode(['--freeze'], {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/AUDIT_FREEZE_CONFIRMED/);
  });

  it('given --freeze with AUDIT_FREEZE_CONFIRMED=true, should freeze', () => {
    expect(resolveBackfillCliMode(['--freeze'], { AUDIT_FREEZE_CONFIRMED: 'true' })).toEqual({
      ok: true,
      command: 'freeze',
    });
  });

  it('given both --apply and --freeze, should refuse (operator must verify between the steps)', () => {
    const result = resolveBackfillCliMode(['--apply', '--freeze'], {
      AUDIT_FREEZE_CONFIRMED: 'true',
    });
    expect(result.ok).toBe(false);
  });

  it('given an unknown flag, should refuse rather than silently ignore it', () => {
    const result = resolveBackfillCliMode(['--aply'], {});
    expect(result.ok).toBe(false);
  });
});

describe('resolveBackfillEnv', () => {
  it('given both URLs, should prefer the owner migrate URL for the admin side', () => {
    const result = resolveBackfillEnv({
      DATABASE_URL: 'postgres://main',
      ADMIN_DATABASE_URL: 'postgres://runtime',
      ADMIN_DATABASE_URL_MIGRATE: 'postgres://owner',
    });
    expect(result).toEqual({
      ok: true,
      mainUrl: 'postgres://main',
      adminUrl: 'postgres://owner',
      breakGlassArmed: false,
    });
  });

  it('given only the runtime admin URL, should use it (self-host: owner IS the runtime URL holder)', () => {
    const result = resolveBackfillEnv({
      DATABASE_URL: 'postgres://main',
      ADMIN_DATABASE_URL: 'postgres://runtime',
    });
    expect(result).toMatchObject({ ok: true, adminUrl: 'postgres://runtime' });
  });

  it('given a missing main or admin URL, should refuse with the variable named', () => {
    const noAdmin = resolveBackfillEnv({ DATABASE_URL: 'postgres://main' });
    expect(noAdmin.ok).toBe(false);
    if (!noAdmin.ok) expect(noAdmin.error).toMatch(/ADMIN_DATABASE_URL/);

    const noMain = resolveBackfillEnv({ ADMIN_DATABASE_URL: 'postgres://runtime' });
    expect(noMain.ok).toBe(false);
    if (!noMain.ok) expect(noMain.error).toMatch(/DATABASE_URL/);
  });

  it('given ADMIN_DB_BREAK_GLASS=true, should flag break-glass so preconditions refuse', () => {
    const result = resolveBackfillEnv({
      DATABASE_URL: 'postgres://main',
      ADMIN_DATABASE_URL: 'postgres://runtime',
      ADMIN_DB_BREAK_GLASS: 'true',
    });
    expect(result).toMatchObject({ ok: true, breakGlassArmed: true });
  });
});

describe('freeze guard column partition', () => {
  it('should keep the mutable allowlist in lockstep with the eraser grant (6 PII columns)', () => {
    expect([...ERASER_MUTABLE_COLUMNS].sort()).toEqual(
      ['geo_location', 'ip_address', 'ip_bidx', 'session_id', 'user_agent', 'user_id'].sort()
    );
  });

  it('should allow every column the GDPR pseudonymization patch writes', () => {
    // The main-store erasure leg keeps running until the legacy table drops
    // (Art 17 is time-bound) — if the patch ever writes a column the freeze
    // guard treats as immutable, erasure would 500 in production.
    const patchColumns: Record<string, string> = {
      ipAddress: 'ip_address',
      ipBidx: 'ip_bidx',
      userAgent: 'user_agent',
      geoLocation: 'geo_location',
      sessionId: 'session_id',
      userId: 'user_id',
    };
    for (const key of Object.keys(buildSecurityAuditPseudonymizationPatch())) {
      const column = patchColumns[key];
      expect(column, `unmapped pseudonymization patch key ${key}`).toBeDefined();
      expect(ERASER_MUTABLE_COLUMNS).toContain(column);
    }
  });

  it('should freeze every chain-relevant column and cover the whole table with no overlap', () => {
    const all = [...ERASER_MUTABLE_COLUMNS, ...FROZEN_IMMUTABLE_COLUMNS].sort();
    expect(all).toEqual(
      [
        'id',
        'event_type',
        'user_id',
        'session_id',
        'service_id',
        'resource_type',
        'resource_id',
        'ip_address',
        'ip_bidx',
        'user_agent',
        'geo_location',
        'details',
        'risk_score',
        'anomaly_flags',
        'timestamp',
        'chain_seq',
        'previous_hash',
        'event_hash',
      ].sort()
    );
    for (const column of FROZEN_IMMUTABLE_COLUMNS) {
      expect(ERASER_MUTABLE_COLUMNS).not.toContain(column);
    }
  });

  it('should build a guard that raises for immutable columns and never mentions mutable ones', () => {
    const sql = buildFreezeGuardFunctionSql();
    for (const column of FROZEN_IMMUTABLE_COLUMNS) {
      expect(sql).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    for (const column of ERASER_MUTABLE_COLUMNS) {
      expect(sql).not.toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });
});

describe('readCursorId', () => {
  const undefinedTable = () => {
    const err = new Error('relation "siem_delivery_cursors" does not exist') as Error & {
      code: string;
    };
    err.code = '42P01';
    return err;
  };

  it('given a missing cursors table on the MAIN side, should tolerate it (odd installs) and resolve null', async () => {
    const db = { query: async () => Promise.reject(undefinedTable()) };
    await expect(readCursorId(db, 'security_audit_log', 'main')).resolves.toBeNull();
  });

  it('given a missing cursors table on the ADMIN side, should abort — a broken admin schema must never silently fall back to the main cursor', async () => {
    const db = { query: async () => Promise.reject(undefinedTable()) };
    await expect(readCursorId(db, 'security_audit_log', 'admin')).rejects.toThrow('does not exist');
  });

  it('given any non-42P01 error on either side, should abort', async () => {
    const db = { query: async () => Promise.reject(new Error('connection refused')) };
    await expect(readCursorId(db, 'security_audit_log', 'main')).rejects.toThrow('connection refused');
  });

  it('given a cursor row, should return its lastDeliveredId', async () => {
    const db = { query: async () => ({ rows: [{ lastDeliveredId: 'evt-42' }], rowCount: 1 }) };
    await expect(readCursorId(db, 'security_audit_log', 'admin')).resolves.toBe('evt-42');
  });
});

describe('cross-module pins', () => {
  it('should pin the SIEM cursor sentinel to the value siem-sources.ts uses', () => {
    // The script cannot import apps/processor (not a package); this literal
    // pin plus the processor-side integration pin catch drift from both ends.
    expect(SIEM_CURSOR_INIT_SENTINEL).toBe('__cursor_init__');
  });

  it("should pin the advisory lock key to the chainer's", () => {
    expect(CHAINER_ADVISORY_LOCK_KEY).toBe('audit-chainer');
  });
});
