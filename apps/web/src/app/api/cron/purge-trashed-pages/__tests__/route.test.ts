import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPageRepo, mockAudit } = vi.hoisted(() => ({
  mockPageRepo: { purgeExpiredTrashedPages: vi.fn() },
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  audit: mockAudit,
  pageRepository: mockPageRepo,
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
        userId: 'system',
        resourceType: 'cron_job',
        resourceId: 'purge_trashed_pages',
        details: { pagesPurged: 3 },
      })
    );
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
