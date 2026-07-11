import { describe, it, expect, beforeEach, vi } from 'vitest';

// withAdminAuth -> just inject a fake admin and call the handler.
vi.mock('@/lib/auth/auth', () => ({
  withAdminAuth: (handler: (user: { id: string }, req: Request) => Promise<Response>) =>
    (req: Request) => handler({ id: 'admin_1' }, req),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/lib/repositories/account-repository', () => ({
  accountRepository: { findById: vi.fn() },
}));
vi.mock('@pagespace/lib/repositories/data-subject-request-repository', () => ({
  dataSubjectRequestRepository: {
    findActiveErasureForUser: vi.fn(),
    listRecent: vi.fn(),
    setForceDelete: vi.fn(),
    markQueued: vi.fn(),
    markFailed: vi.fn(),
  },
}));
vi.mock('@/lib/erasure/request-erasure', () => ({ lodgeAndEnqueueErasure: vi.fn() }));
vi.mock('@/lib/erasure/enqueue', () => ({ enqueueAccountErasure: vi.fn() }));
vi.mock('@pagespace/lib/compliance/erasure/pseudonymize-repository', () => ({
  pseudonymizeActivityLogsForUser: vi.fn(),
  pseudonymizeSecurityAuditLogForUser: vi.fn(),
}));
vi.mock('@pagespace/lib/compliance/erasure/pseudonymize-targets', () => ({
  resolveSecurityAuditErasureTargets: vi.fn(),
}));
vi.mock('@pagespace/lib/monitoring/hash-chain-verifier', () => ({ verifyHashChain: vi.fn() }));
vi.mock('@pagespace/lib/audit/security-audit-chain-verifier', () => ({ verifySecurityAuditChain: vi.fn() }));
vi.mock('@pagespace/lib/audit/security-audit', () => ({ securityAudit: { logEvent: vi.fn() } }));

import { POST as erasurePost } from '../erasure/route';
import { POST as pseudoPost } from '../pseudonymize/route';
import { accountRepository } from '@pagespace/lib/repositories/account-repository';
import { dataSubjectRequestRepository } from '@pagespace/lib/repositories/data-subject-request-repository';
import { lodgeAndEnqueueErasure } from '@/lib/erasure/request-erasure';
import { enqueueAccountErasure } from '@/lib/erasure/enqueue';
import { pseudonymizeActivityLogsForUser, pseudonymizeSecurityAuditLogForUser } from '@pagespace/lib/compliance/erasure/pseudonymize-repository';
import { resolveSecurityAuditErasureTargets } from '@pagespace/lib/compliance/erasure/pseudonymize-targets';
import { verifyHashChain } from '@pagespace/lib/monitoring/hash-chain-verifier';
import { verifySecurityAuditChain } from '@pagespace/lib/audit/security-audit-chain-verifier';
import { securityAudit } from '@pagespace/lib/audit/security-audit';

const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  handler(new Request('https://x/api/admin/gdpr', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => vi.clearAllMocks());

describe('POST /api/admin/gdpr/erasure (force-delete escalation)', () => {
  beforeEach(() => {
    vi.mocked(accountRepository.findById).mockResolvedValue({
      id: 'u1', email: 'a@b.com', image: null, stripeCustomerId: null,
    });
    vi.mocked(dataSubjectRequestRepository.findActiveErasureForUser).mockResolvedValue(null);
    vi.mocked(lodgeAndEnqueueErasure).mockResolvedValue({
      requestId: 'dsr_1', jobId: 'job_1', slaDeadline: new Date('2026-03-01T00:00:00Z'),
    });
  });

  it('given the wrong confirmation phrase, should refuse with 400', async () => {
    const res = await post(erasurePost, { userId: 'u1', confirmation: 'ERASE wrong' });
    expect(res.status).toBe(400);
    expect(lodgeAndEnqueueErasure).not.toHaveBeenCalled();
  });

  it('given a valid confirmation, should queue a force-delete erasure as admin', async () => {
    const res = await post(erasurePost, { userId: 'u1', confirmation: 'ERASE u1' });
    expect(res.status).toBe(202);
    expect(lodgeAndEnqueueErasure).toHaveBeenCalledWith(
      expect.objectContaining({ requestedByType: 'admin', forceDelete: true, callerUserId: 'admin_1' })
    );
  });

  it('given an unknown user, should 404', async () => {
    vi.mocked(accountRepository.findById).mockResolvedValue(null);
    const res = await post(erasurePost, { userId: 'u1', confirmation: 'ERASE u1' });
    expect(res.status).toBe(404);
  });

  it('given a BLOCKED existing request, should grant force-delete and re-queue it', async () => {
    vi.mocked(dataSubjectRequestRepository.findActiveErasureForUser).mockResolvedValue({
      id: 'dsr_blocked', status: 'blocked',
    } as never);
    vi.mocked(enqueueAccountErasure).mockResolvedValue('job_2');
    vi.mocked(dataSubjectRequestRepository.setForceDelete).mockResolvedValue(undefined);
    vi.mocked(dataSubjectRequestRepository.markQueued).mockResolvedValue(1);

    const res = await post(erasurePost, { userId: 'u1', confirmation: 'ERASE u1' });
    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body.requestId).toBe('dsr_blocked');
    expect(dataSubjectRequestRepository.setForceDelete).toHaveBeenCalledWith('dsr_blocked');
    expect(enqueueAccountErasure).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'dsr_blocked', userId: 'u1', callerUserId: 'admin_1' })
    );
    expect(dataSubjectRequestRepository.markQueued).toHaveBeenCalledWith('dsr_blocked', 'job_2');
    // Must NOT create a brand-new request for the blocked one.
    expect(lodgeAndEnqueueErasure).not.toHaveBeenCalled();
  });

  it('given a non-blocked active request, should report it unchanged (202, no requeue)', async () => {
    vi.mocked(dataSubjectRequestRepository.findActiveErasureForUser).mockResolvedValue({
      id: 'dsr_inflight', status: 'in_progress',
    } as never);
    const res = await post(erasurePost, { userId: 'u1', confirmation: 'ERASE u1' });
    expect(res.status).toBe(202);
    expect(enqueueAccountErasure).not.toHaveBeenCalled();
    expect(dataSubjectRequestRepository.setForceDelete).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/gdpr/pseudonymize', () => {
  const validChain = { isValid: true, breakPoint: null } as never;
  const adminWrite = { __client: 'admin-eraser' };
  const adminRead = { __client: 'admin-read' };
  const mainDb = { __client: 'main' };
  const dualTargets = {
    ok: true,
    mode: 'dedicated',
    targets: [
      { store: 'admin', write: adminWrite, read: adminRead },
      { store: 'main', write: mainDb, read: mainDb },
    ],
  } as never;

  beforeEach(() => {
    vi.mocked(resolveSecurityAuditErasureTargets).mockReturnValue(dualTargets);
    vi.mocked(verifyHashChain).mockResolvedValue(validChain);
    vi.mocked(verifySecurityAuditChain).mockResolvedValue(validChain);
    vi.mocked(pseudonymizeActivityLogsForUser).mockResolvedValue(3);
    vi.mocked(pseudonymizeSecurityAuditLogForUser)
      .mockResolvedValueOnce(2) // admin store
      .mockResolvedValueOnce(5); // main store (legacy rows)
    vi.mocked(securityAudit.logEvent).mockResolvedValue(undefined);
  });

  it('given the wrong confirmation, should refuse with 400 and not mutate', async () => {
    const res = await post(pseudoPost, { userId: 'u1', legalBasis: 'dispute', confirmation: 'nope' });
    expect(res.status).toBe(400);
    expect(pseudonymizeActivityLogsForUser).not.toHaveBeenCalled();
  });

  it('given no usable erasure targets (trust plane or eraser unconfigured), should refuse with 503 and the actionable reason — never a silent no-op', async () => {
    vi.mocked(resolveSecurityAuditErasureTargets).mockReturnValue({
      ok: false,
      reason: 'Post-cutover audit PII lives in the Admin PG… ADMIN_ERASER_DATABASE_URL is not set',
    } as never);
    const res = await post(pseudoPost, { userId: 'u1', legalBasis: 'dispute', confirmation: 'PSEUDONYMIZE u1' });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('ADMIN_ERASER_DATABASE_URL');
    expect(pseudonymizeActivityLogsForUser).not.toHaveBeenCalled();
    expect(pseudonymizeSecurityAuditLogForUser).not.toHaveBeenCalled();
  });

  it('given an already-broken chain in ANY store, should refuse with 409 before mutating', async () => {
    vi.mocked(verifySecurityAuditChain)
      .mockResolvedValueOnce(validChain) // admin store
      .mockResolvedValueOnce({ isValid: false, breakPoint: {} } as never); // main store
    const res = await post(pseudoPost, { userId: 'u1', legalBasis: 'dispute', confirmation: 'PSEUDONYMIZE u1' });
    expect(res.status).toBe(409);
    expect(pseudonymizeActivityLogsForUser).not.toHaveBeenCalled();
    expect(pseudonymizeSecurityAuditLogForUser).not.toHaveBeenCalled();
  });

  it('given a valid dual-location run, should erase each store with ITS write client, verify each with ITS read client, self-audit and report per-store counts', async () => {
    const res = await post(pseudoPost, { userId: 'u1', legalBasis: 'dispute', confirmation: 'PSEUDONYMIZE u1' });
    const body = await res.json();
    expect(res.status).toBe(200);

    // Writes go through the store-paired clients (eraser identity on admin).
    expect(pseudonymizeSecurityAuditLogForUser).toHaveBeenNthCalledWith(1, 'u1', { db: adminWrite });
    expect(pseudonymizeSecurityAuditLogForUser).toHaveBeenNthCalledWith(2, 'u1', { db: mainDb });

    // Chain verification targets the stores the rows actually live in —
    // before AND after (2 stores × 2 phases). Never the write client.
    expect(verifySecurityAuditChain).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(verifySecurityAuditChain).mock.calls) {
      expect([adminRead, mainDb]).toContainEqual(call[1]!.db);
    }

    expect(body.activityRowsPseudonymized).toBe(3);
    expect(body.securityRowsPseudonymized).toBe(7); // 2 admin + 5 main
    expect(body.securityRowsByStore).toEqual({ admin: 2, main: 5 });
    expect(body.auditStoreMode).toBe('dedicated');
    expect(body.chainIntact).toBe(true);
    expect(securityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'u1',
        details: expect.objectContaining({
          action: 'art17_pseudonymization',
          securityRowsByStore: { admin: 2, main: 5 },
        }),
      })
    );
  });

  it('given a store write failing part-way, should self-audit the partial state and return 500 telling the operator to re-run', async () => {
    vi.mocked(pseudonymizeSecurityAuditLogForUser)
      .mockReset()
      .mockResolvedValueOnce(2) // admin store succeeds
      .mockRejectedValueOnce(new Error('main db down')); // main store fails

    const res = await post(pseudoPost, { userId: 'u1', legalBasis: 'dispute', confirmation: 'PSEUDONYMIZE u1' });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.failedStore).toBe('main');
    expect(body.securityRowsByStore).toEqual({ admin: 2 });
    expect(body.error).toContain('re-run');
    // The completed mutations stay traceable even though the run failed.
    expect(securityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'u1',
        details: expect.objectContaining({
          action: 'art17_pseudonymization_failed',
          securityRowsByStore: { admin: 2 },
          failedStore: 'main',
        }),
      })
    );
  });

  it('given break-glass mode (single main target), should erase and verify only the main store', async () => {
    vi.mocked(resolveSecurityAuditErasureTargets).mockReturnValue({
      ok: true,
      mode: 'break-glass',
      targets: [{ store: 'main', write: mainDb, read: mainDb }],
    } as never);
    vi.mocked(pseudonymizeSecurityAuditLogForUser).mockReset().mockResolvedValue(4);

    const res = await post(pseudoPost, { userId: 'u1', legalBasis: 'dispute', confirmation: 'PSEUDONYMIZE u1' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(pseudonymizeSecurityAuditLogForUser).toHaveBeenCalledTimes(1);
    expect(pseudonymizeSecurityAuditLogForUser).toHaveBeenCalledWith('u1', { db: mainDb });
    expect(verifySecurityAuditChain).toHaveBeenCalledTimes(2); // before + after, one store
    expect(body.securityRowsByStore).toEqual({ main: 4 });
    expect(body.auditStoreMode).toBe('break-glass');
  });

  it('given the chain breaks AFTER pseudonymization, should fail loudly with 500', async () => {
    vi.mocked(verifyHashChain)
      .mockResolvedValueOnce(validChain) // before
      .mockResolvedValueOnce({ isValid: false, breakPoint: {} } as never); // after
    const res = await post(pseudoPost, { userId: 'u1', legalBasis: 'dispute', confirmation: 'PSEUDONYMIZE u1' });
    expect(res.status).toBe(500);
  });

  it('given a SECURITY store chain break after the run, should fail loudly with 500 naming the store', async () => {
    vi.mocked(verifySecurityAuditChain)
      .mockResolvedValueOnce(validChain) // before: admin
      .mockResolvedValueOnce(validChain) // before: main
      .mockResolvedValueOnce({ isValid: false, breakPoint: { entryId: 'x' } } as never) // after: admin
      .mockResolvedValueOnce(validChain); // after: main
    const res = await post(pseudoPost, { userId: 'u1', legalBasis: 'dispute', confirmation: 'PSEUDONYMIZE u1' });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.securityChainByStore).toEqual({ admin: false, main: true });
  });
});
