import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPageRepo, mockAudit, mockReapOrphanedFiles, mockSweepMachineRefs } = vi.hoisted(() => ({
  mockPageRepo: { purgeExpiredTrashedPages: vi.fn() },
  mockAudit: vi.fn(),
  mockReapOrphanedFiles: vi.fn(),
  mockSweepMachineRefs: vi.fn(),
}));

vi.mock('@/lib/machines/machine-ref-sweep-runtime', () => ({
  sweepDanglingMachineRefs: mockSweepMachineRefs,
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
}));

vi.mock('@pagespace/lib/repositories/page-repository', () => ({
  pageRepository: mockPageRepo,
}));

vi.mock('@pagespace/db/db', () => ({
  db: {},
}));

vi.mock('@/lib/storage/reap-orphaned-files', () => ({
  reapOrphanedFiles: mockReapOrphanedFiles,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

import { GET, POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/purge-trashed-pages');
}

describe('/api/cron/purge-trashed-pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockPageRepo.purgeExpiredTrashedPages.mockResolvedValue(0);
    mockReapOrphanedFiles.mockResolvedValue({
      orphansFound: 0,
      physicalFilesDeleted: 0,
      dbRecordsDeleted: 0,
      failedPhysicalDeletes: [],
    });
    mockSweepMachineRefs.mockResolvedValue({
      deadMachineIds: [],
      agentsUpdated: 0,
      globalConfigsUpdated: 0,
      failures: 0,
    });
  });

  it('given valid HMAC, should purge trashed pages older than 30 days', async () => {
    // Arrange
    mockPageRepo.purgeExpiredTrashedPages.mockResolvedValue(7);

    // Act
    const response = await GET(makeRequest());
    const body = await response.json();

    // Assert
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.pagesPurged).toBe(7);
    expect(body.timestamp).toBeDefined();
  });

  it('given valid HMAC, should pass a cutoff date approximately 30 days ago', async () => {
    // Arrange
    const before = Date.now();

    // Act
    await GET(makeRequest());

    // Assert — the cutoff passed to the repo should be ~30 days ago
    const cutoff: Date = mockPageRepo.purgeExpiredTrashedPages.mock.calls[0][0];
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const after = Date.now();

    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - thirtyDaysMs - 100);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - thirtyDaysMs + 100);
  });

  it('given invalid HMAC, should return auth error and not purge', async () => {
    // Arrange
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    // Act
    const response = await GET(makeRequest());

    // Assert
    expect(response.status).toBe(403);
    expect(mockPageRepo.purgeExpiredTrashedPages).not.toHaveBeenCalled();
  });

  it('given zero eligible pages, should return success with zero count', async () => {
    // Arrange
    mockPageRepo.purgeExpiredTrashedPages.mockResolvedValue(0);

    // Act
    const response = await GET(makeRequest());
    const body = await response.json();

    // Assert
    expect(response.status).toBe(200);
    expect(body.pagesPurged).toBe(0);
  });

  it('should write an audit log entry on successful purge', async () => {
    // Arrange
    mockPageRepo.purgeExpiredTrashedPages.mockResolvedValue(3);

    // Act
    await GET(makeRequest());

    // Assert
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.delete',
        resourceType: 'cron_job',
        resourceId: 'purge_trashed_pages',
        details: { pagesPurged: 3, filesReaped: 0, machineRefsScrubbed: 0 },
      })
    );
  });

  it('reaps orphaned files inline after purge and surfaces the count', async () => {
    mockPageRepo.purgeExpiredTrashedPages.mockResolvedValue(4);
    mockReapOrphanedFiles.mockResolvedValue({
      orphansFound: 2,
      physicalFilesDeleted: 2,
      dbRecordsDeleted: 2,
      failedPhysicalDeletes: [],
    });

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(mockReapOrphanedFiles).toHaveBeenCalledTimes(1);
    expect(body.filesReaped).toBe(2);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { pagesPurged: 4, filesReaped: 2, machineRefsScrubbed: 0 },
      })
    );
  });

  it('still purges successfully when inline reap fails', async () => {
    mockPageRepo.purgeExpiredTrashedPages.mockResolvedValue(5);
    mockReapOrphanedFiles.mockRejectedValue(new Error('processor down'));

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.pagesPurged).toBe(5);
    expect(body.filesReaped).toBe(0);
  });

  it('sweeps dangling machine refs after the purge and surfaces the repair count', async () => {
    // The purge is the moment a trashed Machine page stops existing, so it is
    // the moment its denormalized MachineRefs become permanently dangling.
    mockPageRepo.purgeExpiredTrashedPages.mockResolvedValue(1);
    mockSweepMachineRefs.mockResolvedValue({
      deadMachineIds: ['machine-gone'],
      agentsUpdated: 2,
      globalConfigsUpdated: 1,
      failures: 0,
    });

    const response = await GET(makeRequest());
    const body = await response.json();

    // Unscoped: this run must also catch refs orphaned by paths no call site
    // covers (account erasure, drive cascades).
    expect(mockSweepMachineRefs).toHaveBeenCalledWith();
    expect(body.machineRefsScrubbed).toBe(3);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { pagesPurged: 1, filesReaped: 0, machineRefsScrubbed: 3 },
      })
    );
  });

  it('still purges successfully when the machine-ref sweep fails', async () => {
    mockPageRepo.purgeExpiredTrashedPages.mockResolvedValue(6);
    mockSweepMachineRefs.mockRejectedValue(new Error('deadlock detected'));

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.pagesPurged).toBe(6);
    expect(body.machineRefsScrubbed).toBe(0);
  });

  it('given invalid HMAC, should not log audit event', async () => {
    // Arrange
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    // Act
    await GET(makeRequest());

    // Assert
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('given a DB error, should return 500 and not log audit', async () => {
    // Arrange
    mockPageRepo.purgeExpiredTrashedPages.mockRejectedValue(new Error('connection refused'));

    // Act
    const response = await GET(makeRequest());
    const body = await response.json();

    // Assert
    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe('connection refused');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('POST should delegate to GET', async () => {
    // Arrange
    mockPageRepo.purgeExpiredTrashedPages.mockResolvedValue(2);

    // Act
    const response = await POST(makeRequest());
    const body = await response.json();

    // Assert
    expect(body.success).toBe(true);
    expect(body.pagesPurged).toBe(2);
  });
});
