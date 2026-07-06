/**
 * Regression test for #541: the durable account-erasure job's
 * `anonymize-activity-logs` step must run after `log-account-deletion` and
 * target the same userId, so the resourceTitle scrub in
 * activityLogRepository.anonymizeForUser (packages/lib) actually reaches the
 * account_delete row this worker just wrote. The hash-chain-safety of that
 * scrub itself is proven against real logActivity/anonymizeForUser code in
 * packages/lib/src/monitoring/__tests__/anonymize-resource-title.test.ts —
 * this test only verifies the worker's step wiring (order + arguments), so
 * every collaborator is mocked. (Vitest's mock registry can't intercept
 * @pagespace/db/db from within @pagespace/lib's compiled dist output when
 * imported cross-package like this, so partial-mocking real logActivity here
 * would hit a live Postgres connection instead of a fake — hence the split.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callOrder, mockLogActivity, mockGetActorInfo, mockAnonymizeForUser } = vi.hoisted(() => {
  const callOrder: string[] = [];
  const mockLogActivity = vi.fn().mockImplementation(async () => {
    callOrder.push('logActivity');
  });
  const mockGetActorInfo = vi.fn().mockResolvedValue({ actorEmail: 'actor@test.com', actorDisplayName: 'Actor' });
  const mockAnonymizeForUser = vi.fn().mockImplementation(async () => {
    callOrder.push('anonymizeForUser');
    return { success: true };
  });
  return { callOrder, mockLogActivity, mockGetActorInfo, mockAnonymizeForUser };
});

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  logActivity: mockLogActivity,
  getActorInfo: mockGetActorInfo,
}));

vi.mock('@pagespace/lib/repositories/activity-log-repository', () => ({
  activityLogRepository: { anonymizeForUser: mockAnonymizeForUser },
}));

vi.mock('@pagespace/lib/repositories/account-repository', () => ({
  accountRepository: {
    findById: vi.fn().mockResolvedValue({ id: 'user-1', email: 'user@leaked.example', image: null }),
    getOwnedDrives: vi.fn().mockResolvedValue([]),
    getDriveMemberCount: vi.fn().mockResolvedValue(0),
    deleteDrive: vi.fn().mockResolvedValue(undefined),
    deleteUser: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/lib/repositories/data-subject-request-repository', () => ({
  dataSubjectRequestRepository: {
    findById: vi.fn().mockResolvedValue({ status: 'pending', attempts: 0, forceDelete: false }),
    incrementAttempts: vi.fn().mockResolvedValue(undefined),
    appendStepResult: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/lib/logging/ai-usage-purge', () => ({
  deleteAiUsageLogsForUser: vi.fn().mockResolvedValue(0),
  getDistinctAiProvidersForUser: vi.fn().mockResolvedValue([]),
}));

vi.mock('@pagespace/lib/logging/monitoring-purge', () => ({
  deleteMonitoringDataForUser: vi.fn().mockResolvedValue({}),
}));

vi.mock('@pagespace/lib/compliance/erasure/revoke-integration-tokens', () => ({
  revokeUserIntegrationTokens: vi.fn().mockResolvedValue({ revoked: 0, failed: 0 }),
}));

vi.mock('@pagespace/lib/compliance/erasure/email-suppression', () => ({
  syncEmailSuppression: vi.fn().mockResolvedValue({ skipped: true }),
}));

vi.mock('@pagespace/lib/compliance/erasure/resend-suppression-client', () => ({
  createResendSuppressionClient: vi.fn().mockReturnValue({}),
}));

vi.mock('@pagespace/lib/compliance/erasure/ai-provider-erasure', () => ({
  eraseAiProviderData: vi.fn().mockResolvedValue({ evidence: [], forwarded: 0 }),
}));

vi.mock('@pagespace/lib/audit/security-audit', () => ({
  securityAudit: { logEvent: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@pagespace/lib/deployment-mode', () => ({
  isOnPrem: vi.fn().mockReturnValue(false),
  isTenantMode: vi.fn().mockReturnValue(false),
}));

vi.mock('../../api/avatar', () => ({
  deleteUserAvatars: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { runAccountErasureJob } from '../account-erasure-worker';

describe('runAccountErasureJob — resourceTitle PII scrub wiring (#541)', () => {
  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
  });

  it('logs the account_delete row with resourceTitle=email, then anonymizes the same user', async () => {
    await runAccountErasureJob({ requestId: 'dsr-1', userId: 'user-1' });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        operation: 'account_delete',
        resourceType: 'user',
        resourceId: 'user-1',
        resourceTitle: 'user@leaked.example',
        driveId: null,
      })
    );

    expect(mockAnonymizeForUser).toHaveBeenCalledWith('user-1', expect.any(String));

    // The anonymize step must run AFTER the write step, or its WHERE userId
    // clause can't reach the row the write step just created (#541's root cause).
    expect(callOrder).toEqual(['logActivity', 'anonymizeForUser']);
  });
});
