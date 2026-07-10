/**
 * Full audit verification suite (#890 Phase 2, leaf 5).
 *
 * The composite verifier consults chain + anchors + co-stream where
 * configured and degrades EXPLICITLY (skippedReason, never silence)
 * everywhere else. Anchors are fabricated with the real pure anchor core so
 * signature verification runs for real; chain verification and co-stream
 * reconciliation are injected stubs (their own suites prove them).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { state, mockGetAdminDbMode, mockGetAdminDb, mockLoggers } = vi.hoisted(() => {
  const state = {
    anchorRows: [] as Array<{
      version: number;
      chainSeq: number;
      headHash: string;
      anchoredAt: Date;
      signature: string;
    }>,
    chainRows: [] as Array<{ chainSeq: number; eventHash: string }>,
  };
  return {
    state,
    mockGetAdminDbMode: vi.fn(),
    mockGetAdminDb: vi.fn(),
    mockLoggers: {
      security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  };
});

const { adminDbMock, mainDbMock } = vi.hoisted(() => {
  // select() dispatch: anchors read is select().from().orderBy().limit();
  // chain-row read is select().from().where().
  const adminDbMock = {
    select: vi.fn(() => ({
      from: () => ({
        orderBy: () => ({ limit: async (n: number) => state.anchorRows.slice(0, n) }),
        where: async () => state.chainRows,
      }),
    })),
  };
  const mainDbMock = { select: vi.fn() };
  return { adminDbMock, mainDbMock };
});

vi.mock('@pagespace/db/admin-db', () => ({
  getAdminDb: mockGetAdminDb,
  getAdminDbMode: mockGetAdminDbMode,
}));
vi.mock('@pagespace/db/db', () => ({ db: mainDbMock }));
vi.mock('../../logging/logger-config', () => ({ loggers: mockLoggers }));

import { buildAnchorPayload } from '../anchor';
import {
  anchorRowToSignedAnchor,
  combineAuditVerdicts,
  runFullAuditVerification,
  type StoredAnchorRow,
} from '../full-audit-verification';
import { resetAuditDbBindingForTests } from '../audit-db-binding';
import { setChainAlertHandler } from '../security-audit-alerting';
import type { SecurityChainVerificationResult } from '../security-audit-chain-verifier';
import type { CoStreamReconciliationReport, CoStreamRecord } from '../co-stream';

const SECRET = 'full-audit-verification-test-secret';

const validChainResult = (): SecurityChainVerificationResult => ({
  isValid: true,
  totalEntries: 10,
  entriesVerified: 10,
  validEntries: 10,
  invalidEntries: 0,
  breakPoint: null,
  firstEntryId: 'e1',
  lastEntryId: 'e10',
  verificationStartedAt: new Date(),
  verificationCompletedAt: new Date(),
  durationMs: 1,
});

const invalidChainResult = (): SecurityChainVerificationResult => ({
  ...validChainResult(),
  isValid: false,
  invalidEntries: 1,
});

/** Publish-shaped anchor receipt row for a given head. */
function anchorRow(chainSeq: number, head: string): StoredAnchorRow {
  const anchor = buildAnchorPayload({
    head,
    chainSeq,
    anchoredAt: new Date('2026-07-10T00:00:00.000Z'),
    secret: SECRET,
  });
  return {
    version: anchor.version,
    chainSeq: anchor.chainSeq,
    headHash: anchor.head,
    anchoredAt: new Date(anchor.anchoredAt),
    signature: anchor.signature,
  };
}

const verifiedCoStreamReport = (): CoStreamReconciliationReport => ({
  verified: true,
  results: [],
  counts: { verified: 1, missing_from_store: 0, missing_from_costream: 0, hash_mismatch: 0 },
  head: { matches: true, windowStoreHead: { chainSeq: 1, eventHash: 'h' }, latestChainedHead: { chainSeq: 1, eventHash: 'h' } },
} as unknown as CoStreamReconciliationReport);

const failedCoStreamReport = (): CoStreamReconciliationReport => ({
  ...verifiedCoStreamReport(),
  verified: false,
} as CoStreamReconciliationReport);

describe('anchorRowToSignedAnchor', () => {
  it('round-trips a published anchor so its signature still verifies', () => {
    const row = anchorRow(42, 'a'.repeat(64));
    const rebuilt = anchorRowToSignedAnchor(row);
    expect(rebuilt).toMatchObject({
      version: 1,
      source: 'pagespace-audit-chain',
      chainSeq: 42,
      head: 'a'.repeat(64),
      anchoredAt: '2026-07-10T00:00:00.000Z',
    });
  });
});

describe('combineAuditVerdicts (pure)', () => {
  const chainOk = { isValid: true };
  const chainBad = { isValid: false };
  const anchorsOff = { configured: false as const, skippedReason: 'off' };
  const anchorsOk = { configured: true as const, report: { allMatch: true, results: [], counts: { match: 1, hash_mismatch: 0, seq_gap: 0, unverifiable: 0 } } };
  const anchorsBad = { configured: true as const, report: { ...anchorsOk.report, allMatch: false } };
  const coOff = { configured: false as const, skippedReason: 'off' };
  const coOk = { configured: true as const, report: verifiedCoStreamReport() };
  const coBad = { configured: true as const, report: failedCoStreamReport() };

  it('passes when every configured check passes', () => {
    expect(combineAuditVerdicts({ chain: chainOk, anchors: anchorsOff, coStream: coOff })).toBe(true);
    expect(combineAuditVerdicts({ chain: chainOk, anchors: anchorsOk, coStream: coOk })).toBe(true);
  });

  it('fails on chain failure regardless of the rest', () => {
    expect(combineAuditVerdicts({ chain: chainBad, anchors: anchorsOk, coStream: coOk })).toBe(false);
  });

  it('fails on configured-anchor mismatch', () => {
    expect(combineAuditVerdicts({ chain: chainOk, anchors: anchorsBad, coStream: coOff })).toBe(false);
  });

  it('fails on configured-co-stream failure', () => {
    expect(combineAuditVerdicts({ chain: chainOk, anchors: anchorsOff, coStream: coBad })).toBe(false);
  });

  it('skipped checks never fail the run', () => {
    expect(combineAuditVerdicts({ chain: chainOk, anchors: anchorsOff, coStream: coOff })).toBe(true);
  });
});

describe('runFullAuditVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuditDbBindingForTests();
    state.anchorRows.length = 0;
    state.chainRows.length = 0;
    mockGetAdminDb.mockReturnValue(adminDbMock);
    mockGetAdminDbMode.mockReturnValue({ mode: 'dedicated', reason: 'set' });
  });

  afterEach(() => {
    setChainAlertHandler(null);
  });

  const anchorEnv = { AUDIT_ANCHOR_ENABLED: 'true', AUDIT_ANCHOR_SECRET: SECRET };

  it('threads the binding db into chain verification and defaults to chain-only when anchors/co-stream are off', async () => {
    const verifyChain = vi.fn().mockResolvedValue(validChainResult());

    const result = await runFullAuditVerification(
      { source: 'periodic', chain: { stopOnFirstBreak: true } },
      { env: {}, verifyChain },
    );

    expect(verifyChain).toHaveBeenCalledWith('periodic', { stopOnFirstBreak: true }, { db: adminDbMock });
    expect(result.isValid).toBe(true);
    expect(result.anchors.configured).toBe(false);
    expect(result.coStream).toMatchObject({ configured: false });
    // The skip is reported, never silent.
    expect(mockLoggers.security.info).toHaveBeenCalledWith(
      expect.stringContaining('anchor check skipped'),
      expect.objectContaining({ skippedReason: expect.stringContaining('AUDIT_ANCHOR_ENABLED') }),
    );
  });

  it('given enabled anchoring but a missing secret, should skip with an explicit reason', async () => {
    const result = await runFullAuditVerification(
      {},
      { env: { AUDIT_ANCHOR_ENABLED: 'true' }, verifyChain: vi.fn().mockResolvedValue(validChainResult()) },
    );
    expect(result.anchors).toMatchObject({
      configured: false,
      skippedReason: expect.stringContaining('AUDIT_ANCHOR_SECRET'),
    });
  });

  it('given anchoring enabled but no anchors published yet, should skip (not fail) with an explicit reason', async () => {
    const result = await runFullAuditVerification(
      {},
      { env: anchorEnv, verifyChain: vi.fn().mockResolvedValue(validChainResult()) },
    );
    expect(result.anchors).toMatchObject({
      configured: false,
      skippedReason: expect.stringContaining('no anchors'),
    });
    expect(result.isValid).toBe(true);
  });

  it('given anchors that match the chain, should verify clean (chain AND anchors)', async () => {
    const head5 = 'b'.repeat(64);
    const head9 = 'c'.repeat(64);
    state.anchorRows.push(anchorRow(5, head5), anchorRow(9, head9));
    state.chainRows.push({ chainSeq: 5, eventHash: head5 }, { chainSeq: 9, eventHash: head9 });

    const result = await runFullAuditVerification(
      {},
      { env: anchorEnv, verifyChain: vi.fn().mockResolvedValue(validChainResult()) },
    );

    expect(result.anchors).toMatchObject({ configured: true });
    if (result.anchors.configured) {
      expect(result.anchors.report.allMatch).toBe(true);
      expect(result.anchors.report.counts.match).toBe(2);
    }
    expect(result.isValid).toBe(true);
    expect(mockLoggers.security.error).not.toHaveBeenCalled();
  });

  it('given a chain rewritten under a witnessed head, should fail, log a security error, and fire the anchor_verify alert', async () => {
    const witnessedHead = 'd'.repeat(64);
    state.anchorRows.push(anchorRow(7, witnessedHead));
    state.chainRows.push({ chainSeq: 7, eventHash: 'e'.repeat(64) }); // rewritten

    const handler = vi.fn();
    setChainAlertHandler(handler);

    const result = await runFullAuditVerification(
      {},
      { env: anchorEnv, verifyChain: vi.fn().mockResolvedValue(validChainResult()) },
    );

    expect(result.isValid).toBe(false);
    if (result.anchors.configured) {
      expect(result.anchors.report.counts.hash_mismatch).toBe(1);
    }
    expect(mockLoggers.security.error).toHaveBeenCalledWith(
      expect.stringContaining('Anchor-vs-chain verification FAILED'),
      expect.anything(),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    const alert = handler.mock.calls[0]![0];
    expect(alert.source).toBe('anchor_verify');
    expect(alert.result.breakPoint.description).toContain('chain_seq 7');
  });

  it('given a missing chain row below a witnessed head, should fail with a seq_gap', async () => {
    state.anchorRows.push(anchorRow(3, 'f'.repeat(64)));
    // no chain row at seq 3

    const result = await runFullAuditVerification(
      {},
      { env: anchorEnv, verifyChain: vi.fn().mockResolvedValue(validChainResult()) },
    );

    expect(result.isValid).toBe(false);
    if (result.anchors.configured) {
      expect(result.anchors.report.counts.seq_gap).toBe(1);
    }
  });

  it('given a forged anchor signature, should count it unverifiable and fail', async () => {
    const row = anchorRow(4, 'a'.repeat(64));
    state.anchorRows.push({ ...row, signature: '0'.repeat(64) });
    state.chainRows.push({ chainSeq: 4, eventHash: 'a'.repeat(64) });

    const result = await runFullAuditVerification(
      {},
      { env: anchorEnv, verifyChain: vi.fn().mockResolvedValue(validChainResult()) },
    );

    expect(result.isValid).toBe(false);
    if (result.anchors.configured) {
      expect(result.anchors.report.counts.unverifiable).toBe(1);
    }
  });

  it('given co-stream records, should run reconciliation against the binding db and fold the verdict in', async () => {
    const reconcileCoStream = vi.fn().mockResolvedValue(verifiedCoStreamReport());
    const window = { start: new Date('2026-07-10T00:00:00Z'), end: new Date('2026-07-10T01:00:00Z') };
    const records: CoStreamRecord[] = [
      { eventId: 'e1', emissionHash: 'h', eventType: 'data.read', emittedAt: '2026-07-10T00:30:00.000Z' },
    ];

    const result = await runFullAuditVerification(
      { coStream: { records, window } },
      { env: {}, verifyChain: vi.fn().mockResolvedValue(validChainResult()), reconcileCoStream },
    );

    expect(reconcileCoStream).toHaveBeenCalledWith({ records, db: adminDbMock, window });
    expect(result.coStream).toMatchObject({ configured: true });
    expect(result.isValid).toBe(true);
  });

  it('given a failed co-stream reconciliation, should fail and log a security error', async () => {
    const reconcileCoStream = vi.fn().mockResolvedValue(failedCoStreamReport());
    const window = { start: new Date(0), end: new Date(1) };

    const result = await runFullAuditVerification(
      { coStream: { records: [], window } },
      { env: {}, verifyChain: vi.fn().mockResolvedValue(validChainResult()), reconcileCoStream },
    );

    expect(result.isValid).toBe(false);
    expect(mockLoggers.security.error).toHaveBeenCalledWith(
      expect.stringContaining('Co-stream reconciliation FAILED'),
      expect.anything(),
    );
  });

  it('given break-glass, should run the chain check on the MAIN db and skip anchors + co-stream explicitly', async () => {
    mockGetAdminDbMode.mockReturnValue({ mode: 'break-glass', reason: 'armed' });
    const verifyChain = vi.fn().mockResolvedValue(validChainResult());

    const result = await runFullAuditVerification(
      { coStream: { records: [], window: { start: new Date(0), end: new Date(1) } } },
      { env: anchorEnv, verifyChain },
    );

    expect(verifyChain).toHaveBeenCalledWith('manual', undefined, { db: mainDbMock });
    expect(result.anchors).toMatchObject({
      configured: false,
      skippedReason: expect.stringContaining('break-glass'),
    });
    expect(result.coStream).toMatchObject({
      configured: false,
      skippedReason: expect.stringContaining('break-glass'),
    });
    expect(result.isValid).toBe(true);
  });

  it('given an invalid chain, should fail even when anchors and co-stream are skipped', async () => {
    const result = await runFullAuditVerification(
      {},
      { env: {}, verifyChain: vi.fn().mockResolvedValue(invalidChainResult()) },
    );
    expect(result.isValid).toBe(false);
  });
});
