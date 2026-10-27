/**
 * Unit tests for the durable email-broadcast worker.
 *
 * Every @pagespace/lib collaborator that touches the outside world (repository,
 * audience queries, engine, suppression read, PII decrypt) is mocked, matching
 * account-erasure-worker.test.ts — vitest can't intercept @pagespace/db/db from
 * within lib's compiled dist, so partial-mocking would hit a live Postgres.
 * `services/broadcast/core` is deliberately REAL: `runBroadcast` is the pure
 * orchestrator whose decide→claim→send→record semantics these tests exist to
 * prove the worker wires correctly (resume skips, rate-limit failures recorded
 * `failed` not `sent`, dry runs sending nothing).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRepo,
  mockLedger,
  mockResolveAudience,
  mockLoadOptedOut,
  mockLoadRightsRestricted,
  mockResolveContent,
  mockExtractCtaUrls,
  mockRenderMarkdown,
  mockCreateEngine,
  mockEngine,
  mockListSuppressed,
  mockIsOnPrem,
} = vi.hoisted(() => {
  const mockLedger = {
    claim: vi.fn(),
    record: vi.fn(),
    onSkip: vi.fn(),
    onFailure: vi.fn(),
  };
  const mockRepo = {
    findById: vi.fn(),
    findTemplateById: vi.fn(),
    incrementAttempts: vi.fn(),
    updateStatus: vi.fn(),
    appendStepResult: vi.fn(),
    updateCounts: vi.fn(),
    loadAlreadySentEmails: vi.fn(),
    countRecipientsByStatus: vi.fn(),
    createBroadcastLedger: vi.fn(() => mockLedger),
  };
  const mockEngine = {
    name: 'transactional',
    preflight: vi.fn(),
    sendOne: vi.fn(),
    renderOne: vi.fn(),
  };
  return {
    mockRepo,
    mockLedger,
    mockResolveAudience: vi.fn(),
    mockLoadOptedOut: vi.fn(),
    mockLoadRightsRestricted: vi.fn(),
    mockResolveContent: vi.fn(),
    mockExtractCtaUrls: vi.fn(),
    mockRenderMarkdown: vi.fn(),
    mockCreateEngine: vi.fn(() => mockEngine),
    mockEngine,
    mockListSuppressed: vi.fn(),
    mockIsOnPrem: vi.fn(),
  };
});

vi.mock('@pagespace/lib/repositories/broadcast-repository', () => ({
  broadcastRepository: mockRepo,
}));

vi.mock('@pagespace/lib/services/broadcast/audience', () => ({
  resolveAudience: mockResolveAudience,
  loadOptedOutUserIds: mockLoadOptedOut,
  loadRightsRestrictedUserIds: mockLoadRightsRestricted,
}));

vi.mock('@pagespace/lib/services/broadcast/content', () => ({
  resolveBroadcastContent: mockResolveContent,
  extractCtaUrls: mockExtractCtaUrls,
  renderMarkdownToSafeHtml: mockRenderMarkdown,
}));

vi.mock('@pagespace/lib/services/broadcast/transactional-engine', () => ({
  createTransactionalEngine: mockCreateEngine,
}));

vi.mock('@pagespace/lib/compliance/erasure/resend-suppression-client', () => ({
  listSuppressedEmails: mockListSuppressed,
}));

vi.mock('@pagespace/lib/auth/user-repository', () => ({
  decryptUserRow: vi.fn(async (row: unknown) => row),
}));

vi.mock('@pagespace/lib/validators/email', () => ({
  isValidEmail: (email: string) => email.includes('@'),
}));

vi.mock('@pagespace/lib/deployment-mode', () => ({
  isOnPrem: mockIsOnPrem,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { runEmailBroadcastJob } from '../email-broadcast-worker';

interface TestBroadcast {
  id: string;
  subject: string;
  contentMode: 'compose' | 'template';
  templateId: string | null;
  bodyMarkdown: string | null;
  notificationType: string;
  audienceDefinition: Record<string, unknown>;
  status: string;
  dryRun: boolean;
  sendLimit: number | null;
  delayMs: number;
  attempts: number;
  startedAt: Date | null;
}

function makeBroadcast(overrides: Partial<TestBroadcast> = {}): TestBroadcast {
  return {
    id: 'bcast-1',
    subject: 'Big news',
    contentMode: 'compose',
    templateId: null,
    bodyMarkdown: 'Hello **world**',
    notificationType: 'PRODUCT_UPDATE',
    audienceDefinition: {},
    status: 'queued',
    dryRun: false,
    sendLimit: null,
    delayMs: 0,
    attempts: 0,
    startedAt: null,
    ...overrides,
  };
}

const page = (rows: Array<{ id: string; name: string | null; email: string | null }>, nextCursor: string | null = null) => ({
  rows,
  nextCursor,
});

const ADA = { id: 'user-ada', name: 'Ada', email: 'ada@example.com' };
const BOB = { id: 'user-bob', name: 'Bob', email: 'bob@example.com' };

/** Every worker status write carries the guard that keeps it from overturning an
 *  admin's cancel/pause; assertions accept any guard shape that includes those. */
const guarded = expect.objectContaining({
  unlessStatus: expect.arrayContaining(['cancelled', 'paused']),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRepo.createBroadcastLedger.mockReturnValue(mockLedger);
  mockRepo.loadAlreadySentEmails.mockResolvedValue(new Set());
  mockRepo.countRecipientsByStatus.mockResolvedValue({ pending: 0, sent: 0, skipped: 0, failed: 0 });
  mockRepo.updateStatus.mockResolvedValue(1);
  mockLedger.claim.mockResolvedValue(true);
  mockLedger.record.mockResolvedValue(undefined);
  mockLedger.onSkip.mockResolvedValue(undefined);
  mockLedger.onFailure.mockResolvedValue(undefined);
  mockLoadOptedOut.mockResolvedValue(new Set());
  mockLoadRightsRestricted.mockResolvedValue(new Set());
  mockListSuppressed.mockResolvedValue(new Set());
  mockIsOnPrem.mockReturnValue(false);
  mockResolveContent.mockImplementation(async (b: TestBroadcast) => ({
    subject: b.subject,
    bodyMarkdown: b.bodyMarkdown ?? '',
  }));
  mockRenderMarkdown.mockReturnValue('<p>Hello <strong>world</strong></p>');
  mockExtractCtaUrls.mockReturnValue([]);
  mockCreateEngine.mockReturnValue(mockEngine);
  mockEngine.preflight.mockResolvedValue({ ok: true });
  mockEngine.sendOne.mockResolvedValue(undefined);
  mockEngine.renderOne.mockResolvedValue('<html>rendered</html>');
  mockResolveAudience.mockResolvedValue(page([]));
});

describe('runEmailBroadcastJob — terminal short-circuits', () => {
  it('drops the job when the broadcast row is gone', async () => {
    mockRepo.findById.mockResolvedValue(null);
    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });
    expect(mockRepo.incrementAttempts).not.toHaveBeenCalled();
    expect(mockEngine.sendOne).not.toHaveBeenCalled();
  });

  it.each(['completed', 'cancelled', 'paused'] as const)(
    'does nothing when the broadcast is already %s',
    async (status) => {
      mockRepo.findById.mockResolvedValue(makeBroadcast({ status }));
      await runEmailBroadcastJob({ broadcastId: 'bcast-1' });
      expect(mockRepo.incrementAttempts).not.toHaveBeenCalled();
      expect(mockResolveAudience).not.toHaveBeenCalled();
      expect(mockEngine.sendOne).not.toHaveBeenCalled();
    },
  );

  it('stops without sending when a cancel wins the race for the in_progress transition', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast());
    // The guarded write reports 0 rows: an operator state landed first.
    mockRepo.updateStatus.mockResolvedValue(0);

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    expect(mockResolveContent).not.toHaveBeenCalled();
    expect(mockEngine.sendOne).not.toHaveBeenCalled();
  });
});

describe('runEmailBroadcastJob — on-prem guard', () => {
  it('refuses a live run on-prem (failed + blockedReason), sending nothing and NOT throwing', async () => {
    mockIsOnPrem.mockReturnValue(true);
    mockRepo.findById.mockResolvedValue(makeBroadcast({ dryRun: false }));

    // Returns (not throws): retrying a deployment-mode problem just re-fails it.
    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      'bcast-1',
      'failed',
      expect.objectContaining({ blockedReason: expect.stringContaining('on-prem') }),
      guarded,
    );
    expect(mockResolveAudience).not.toHaveBeenCalled();
    expect(mockEngine.sendOne).not.toHaveBeenCalled();
    expect(mockEngine.renderOne).not.toHaveBeenCalled();
  });

  it('still allows a dry run on-prem (renders, sends nothing)', async () => {
    mockIsOnPrem.mockReturnValue(true);
    mockRepo.findById.mockResolvedValue(makeBroadcast({ dryRun: true }));
    mockResolveAudience.mockResolvedValue(page([ADA]));

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    expect(mockEngine.sendOne).not.toHaveBeenCalled();
    expect(mockEngine.renderOne).toHaveBeenCalledTimes(1);
    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      'bcast-1',
      'completed',
      expect.objectContaining({ completedAt: expect.any(Date) }),
      guarded,
    );
  });
});

describe('runEmailBroadcastJob — preflight', () => {
  it('marks failed with the engine preflight reason and stops', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast());
    mockEngine.preflight.mockResolvedValue({ ok: false, reason: 'FROM_EMAIL is not set' });

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      'bcast-1',
      'failed',
      expect.objectContaining({ blockedReason: 'FROM_EMAIL is not set' }),
      guarded,
    );
    expect(mockResolveAudience).not.toHaveBeenCalled();
    expect(mockEngine.sendOne).not.toHaveBeenCalled();
  });

  it('marks failed when content cannot be resolved', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast({ bodyMarkdown: null }));
    mockResolveContent.mockRejectedValue(new Error('Broadcast is in compose mode but has no body.'));

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      'bcast-1',
      'failed',
      expect.objectContaining({
        blockedReason: 'Broadcast is in compose mode but has no body.',
      }),
      guarded,
    );
    expect(mockEngine.sendOne).not.toHaveBeenCalled();
  });

  it('marks failed and stops when a live body carries an unreachable link', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast());
    mockExtractCtaUrls.mockReturnValue(['https://pagespace.ai/gone']);
    // findUnreachableUrls is the REAL core implementation, driven by global fetch.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 404 } as Response);

    try {
      await runEmailBroadcastJob({ broadcastId: 'bcast-1' });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      'bcast-1',
      'failed',
      expect.objectContaining({
        blockedReason: expect.stringContaining('https://pagespace.ai/gone'),
      }),
      guarded,
    );
    expect(mockEngine.sendOne).not.toHaveBeenCalled();
  });

  it('clears a stale blockedReason when a refused broadcast is re-run after the config fix', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast({ status: 'failed' }));

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    // Without this, the earlier refusal ('FROM_EMAIL is not set…') survives onto
    // a row that then completes, and the admin UI shows a successful send
    // annotated with a blocking reason.
    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      'bcast-1',
      'in_progress',
      expect.objectContaining({ blockedReason: null, lastError: null }),
      expect.anything(),
    );
  });
});

describe('runEmailBroadcastJob — resume', () => {
  it('skips already-sent recipients and mails only the remainder', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast());
    mockRepo.loadAlreadySentEmails.mockResolvedValue(new Set(['ada@example.com']));
    mockResolveAudience.mockResolvedValue(page([ADA, BOB]));

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    expect(mockEngine.sendOne).toHaveBeenCalledTimes(1);
    expect(mockEngine.sendOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-bob', email: 'bob@example.com' }),
    );
    // 'already-sent' skips are deliberately NOT persisted: Ada's ledger row is
    // already `sent` (recordSkip's guard would refuse the demotion anyway), and a
    // 49k-sent resume must not burn one no-op round trip per mailed recipient.
    expect(mockLedger.onSkip).not.toHaveBeenCalled();
    expect(mockLedger.claim).toHaveBeenCalledTimes(1);
    expect(mockLedger.record).toHaveBeenCalledTimes(1);
    expect(mockLedger.record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-bob', email: 'bob@example.com' }),
    );
    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      'bcast-1',
      'completed',
      expect.objectContaining({ completedAt: expect.any(Date) }),
      guarded,
    );
  });

  it('still persists non-resume skips (opted-out) through the ledger', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast());
    mockLoadOptedOut.mockResolvedValue(new Set(['user-ada']));
    mockResolveAudience.mockResolvedValue(page([ADA, BOB]));

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    expect(mockLedger.onSkip).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-ada', reason: 'opted-out' }),
    );
    expect(mockEngine.sendOne).toHaveBeenCalledTimes(1);
  });
});

describe('runEmailBroadcastJob — canary sendLimit', () => {
  it('stops at sendLimit attempts within a run', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast({ sendLimit: 1 }));
    mockResolveAudience
      .mockResolvedValueOnce(page([ADA, BOB], 'user-bob'))
      .mockResolvedValue(page([], null));

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    expect(mockEngine.sendOne).toHaveBeenCalledTimes(1);
    // The limit break happens before a second page is fetched.
    expect(mockResolveAudience).toHaveBeenCalledTimes(1);
    const steps = mockRepo.appendStepResult.mock.calls.map(([, r]) => r.step);
    expect(steps).toContain('send-limit');
  });

  it('counts attempts from PRIOR runs against the budget, so a retry cannot escalate a canary', async () => {
    // A 2-person canary whose first attempt sent 1 and failed 1: the pg-boss
    // retry must attempt NOTHING — a per-process counter would hand it a fresh
    // budget of 2 brand-new people per retry, walking far past the cap.
    mockRepo.findById.mockResolvedValue(makeBroadcast({ sendLimit: 2 }));
    mockRepo.countRecipientsByStatus.mockResolvedValue({ pending: 0, sent: 1, skipped: 0, failed: 1 });
    mockRepo.loadAlreadySentEmails.mockResolvedValue(new Set(['ada@example.com']));
    mockResolveAudience.mockResolvedValue(page([ADA, BOB]));

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    expect(mockEngine.sendOne).not.toHaveBeenCalled();
    const steps = mockRepo.appendStepResult.mock.calls.map(([, r]) => r.step);
    expect(steps).toContain('send-limit');
  });
});

describe('runEmailBroadcastJob — send failures', () => {
  it('records a rate-limit throw as a per-recipient failure (never sent) and rethrows for pg-boss retry', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast());
    mockResolveAudience.mockResolvedValue(page([ADA]));
    mockEngine.sendOne.mockRejectedValue(
      new Error('Too many emails sent to ada@example.com. Please try again later.'),
    );

    await expect(runEmailBroadcastJob({ broadcastId: 'bcast-1' })).rejects.toThrow(
      /finished with failures/,
    );

    expect(mockLedger.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-ada', email: 'ada@example.com' }),
    );
    // The one write that must never happen on a failed send:
    expect(mockLedger.record).not.toHaveBeenCalled();
    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      'bcast-1',
      'failed',
      expect.objectContaining({ lastError: expect.stringContaining('1 recipient(s) failed') }),
      guarded,
    );
    // The address is redacted before it can land on the row.
    const failedCall = mockRepo.updateStatus.mock.calls.find(([, status]) => status === 'failed');
    expect(failedCall?.[2]?.lastError).not.toContain('ada@example.com');
  });

  it('does not mail a claimed recipient, and does NOT declare the broadcast completed over them', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast());
    mockResolveAudience.mockResolvedValue(page([ADA]));
    mockLedger.claim.mockResolvedValue(false);

    // The rival's outcome is unknown: it may have died mid-send. Completing here
    // would strand the recipient as pending forever (the terminal short-circuit
    // drops every future job). Retry instead — the resume set makes it cheap.
    await expect(runEmailBroadcastJob({ broadcastId: 'bcast-1' })).rejects.toThrow(
      /claimed by another worker/,
    );

    expect(mockEngine.sendOne).not.toHaveBeenCalled();
    expect(mockLedger.record).not.toHaveBeenCalled();
    expect(mockRepo.updateStatus).not.toHaveBeenCalledWith(
      'bcast-1',
      'completed',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('runEmailBroadcastJob — mid-run cancel/pause', () => {
  it('halts between pages when the admin cancels, and never overwrites the cancel', async () => {
    // Job-start read is 'queued'; the page-2 pre-flight read sees the cancel.
    mockRepo.findById
      .mockResolvedValueOnce(makeBroadcast())
      .mockResolvedValueOnce(makeBroadcast())
      .mockResolvedValue(makeBroadcast({ status: 'cancelled' }));
    mockResolveAudience
      .mockResolvedValueOnce(page([ADA], 'user-ada'))
      .mockResolvedValue(page([BOB], null));

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    // Page 1 was sent before the cancel; page 2 must never be fetched or mailed.
    expect(mockEngine.sendOne).toHaveBeenCalledTimes(1);
    expect(mockEngine.sendOne).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-ada' }));
    const steps = mockRepo.appendStepResult.mock.calls.map(([, r]) => r.step);
    expect(steps).toContain('halted');
    expect(mockRepo.updateStatus).not.toHaveBeenCalledWith(
      'bcast-1',
      'completed',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('runEmailBroadcastJob — dry run', () => {
  it('renders every recipient, sends nothing, and writes no recipient rows', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast({ dryRun: true }));
    mockResolveAudience.mockResolvedValue(page([ADA, BOB]));

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    expect(mockEngine.sendOne).not.toHaveBeenCalled();
    expect(mockEngine.renderOne).toHaveBeenCalledTimes(2);
    // No ledger traffic at all on a dry run: no claims, no sent rows, no skip rows.
    expect(mockLedger.claim).not.toHaveBeenCalled();
    expect(mockLedger.record).not.toHaveBeenCalled();
    expect(mockLedger.onSkip).not.toHaveBeenCalled();
    // Counts still advance (from the in-memory tally, not the ledger).
    expect(mockRepo.updateCounts).toHaveBeenCalledWith(
      'bcast-1',
      expect.objectContaining({ totalTargeted: 2, sentCount: 2, failedCount: 0 }),
    );
    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      'bcast-1',
      'completed',
      expect.objectContaining({ completedAt: expect.any(Date) }),
      guarded,
    );
  });
});

describe('runEmailBroadcastJob — pagination, counts and step results', () => {
  it('walks the keyset pages, updating counts + step results after each batch', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast());
    mockResolveAudience
      .mockResolvedValueOnce(page([ADA], 'user-ada'))
      .mockResolvedValueOnce(page([BOB], null));
    mockRepo.countRecipientsByStatus
      .mockResolvedValueOnce({ pending: 0, sent: 1, skipped: 0, failed: 0 })
      .mockResolvedValueOnce({ pending: 0, sent: 2, skipped: 0, failed: 0 });

    await runEmailBroadcastJob({ broadcastId: 'bcast-1' });

    // Second resolve continues from the first page's cursor.
    expect(mockResolveAudience).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ after: 'user-ada' }),
    );
    expect(mockEngine.sendOne).toHaveBeenCalledTimes(2);

    // Live counts are recomputed from the ledger after every page.
    expect(mockRepo.updateCounts).toHaveBeenNthCalledWith(
      1,
      'bcast-1',
      expect.objectContaining({ totalTargeted: 1, sentCount: 1 }),
    );
    expect(mockRepo.updateCounts).toHaveBeenNthCalledWith(
      2,
      'bcast-1',
      expect.objectContaining({ totalTargeted: 2, sentCount: 2 }),
    );

    const steps = mockRepo.appendStepResult.mock.calls.map(([, r]) => r.step);
    expect(steps).toEqual(expect.arrayContaining(['batch-1', 'batch-2', 'finalize']));
  });
});

describe('runEmailBroadcastJob — suppression read', () => {
  it('surfaces an unreadable suppression list as a retryable throw', async () => {
    mockRepo.findById.mockResolvedValue(makeBroadcast());
    mockListSuppressed.mockRejectedValue(new Error('Resend 500'));

    await expect(runEmailBroadcastJob({ broadcastId: 'bcast-1' })).rejects.toThrow('Resend 500');

    expect(mockRepo.updateStatus).toHaveBeenCalledWith(
      'bcast-1',
      'failed',
      expect.objectContaining({ lastError: 'Resend 500' }),
      guarded,
    );
    expect(mockEngine.sendOne).not.toHaveBeenCalled();
  });
});
