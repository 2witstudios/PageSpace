/**
 * Contract tests for /api/cron/verify-db-backup-freshness
 *
 * Verifies: HMAC auth short-circuit, 503 + Sentry escalation on every failure
 * mode, Sentry flush before responding (the alert must survive a recycled
 * container), stable fingerprinting so a daily-firing alert doesn't open a new
 * issue every day, list pagination, and audit coverage.
 */

// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockSend,
  mockCaptureException,
  mockFlush,
  mockLoggers,
  mockAudit,
  mockValidate,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockCaptureException: vi.fn(),
  mockFlush: vi.fn(async () => true),
  mockLoggers: {
    security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  mockAudit: vi.fn(),
  mockValidate: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: mockValidate,
}));

vi.mock('@/lib/presigned-url', () => ({
  getS3Client: () => ({ send: mockSend }),
  getS3Bucket: () => 'wispy-wood-9053',
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: mockCaptureException,
  flush: mockFlush,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: mockLoggers,
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
}));

vi.mock('@aws-sdk/client-s3', () => ({
  ListObjectsV2Command: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
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

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

/** One non-truncated listing page. */
function page(contents: Array<{ Key: string; LastModified?: Date; Size?: number }>) {
  return { Contents: contents, IsTruncated: false };
}

const FRESH_ENC = {
  Key: 'db-backups/pagespace-2026-08-08.dump.enc',
  LastModified: hoursAgo(2),
  Size: 458_444_832,
};

describe('GET /api/cron/verify-db-backup-freshness', () => {
  const request = new Request('https://app.pagespace.ai/api/cron/verify-db-backup-freshness');

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockReturnValue(null);
    mockFlush.mockResolvedValue(true);
    delete process.env.BACKUP_MAX_AGE_HOURS;
  });

  it('rejects an unsigned request without touching S3', async () => {
    mockValidate.mockReturnValue(new Response('Unauthorized', { status: 401 }));

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('returns 200 for a fresh encrypted backup and does not alert', async () => {
    mockSend.mockResolvedValue(page([FRESH_ENC]));

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.reason).toBe('fresh');
    expect(body.encrypted).toBe(true);
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggers.security.error).not.toHaveBeenCalled();
    expect(mockLoggers.api.info).toHaveBeenCalled();
  });

  it('lists under the db-backups/ prefix', async () => {
    mockSend.mockResolvedValue(page([FRESH_ENC]));

    await GET(request);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input.Prefix).toBe('db-backups/');
    expect(command.input.Bucket).toBe('wispy-wood-9053');
  });

  it('returns 503 and escalates to Sentry when the newest dump is stale', async () => {
    mockSend.mockResolvedValue(
      page([{ Key: 'db-backups/pagespace-2026-06-25.dump', LastModified: hoursAgo(1067), Size: 226_050_458 }])
    );

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('stale');
    expect(mockLoggers.security.error).toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);

    const [error, context] = mockCaptureException.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[BACKUP ALERT]');
    expect(context.level).toBe('fatal');
    expect(context.tags.check).toBe('db_backup_freshness');
  });

  it('flushes Sentry before responding so a recycled container cannot drop the alert', async () => {
    mockSend.mockResolvedValue(page([]));

    await GET(request);

    expect(mockFlush).toHaveBeenCalled();
    expect(mockCaptureException.mock.invocationCallOrder[0]).toBeLessThan(
      mockFlush.mock.invocationCallOrder[0]
    );
  });

  it('fingerprints by reason, not by message, so a daily alert stays one issue', async () => {
    mockSend.mockResolvedValue(page([]));
    await GET(request);
    const first = mockCaptureException.mock.calls[0][1].fingerprint;

    vi.clearAllMocks();
    mockValidate.mockReturnValue(null);
    // Same fault a day later — the age in the message has changed.
    mockSend.mockResolvedValue(page([]));
    await GET(request);
    const second = mockCaptureException.mock.calls[0][1].fingerprint;

    expect(first).toEqual(['db-backup-freshness', 'no_objects']);
    expect(second).toEqual(first);
  });

  it('returns 503 when the prefix is empty', async () => {
    mockSend.mockResolvedValue(page([]));

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.reason).toBe('no_objects');
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('returns 503 for a fresh but unencrypted dump — the check cannot be greened by dropping encryption', async () => {
    mockSend.mockResolvedValue(
      page([{ Key: 'db-backups/pagespace-2026-08-08.dump', LastModified: hoursAgo(2), Size: 1000 }])
    );

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.reason).toBe('not_encrypted');
    expect(body.encrypted).toBe(false);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('returns 503 for a fresh encrypted but zero-byte object', async () => {
    mockSend.mockResolvedValue(page([{ ...FRESH_ENC, Size: 0 }]));

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.reason).toBe('empty_object');
  });

  it('honours BACKUP_MAX_AGE_HOURS', async () => {
    mockSend.mockResolvedValue(page([{ ...FRESH_ENC, LastModified: hoursAgo(20) }]));

    process.env.BACKUP_MAX_AGE_HOURS = '12';
    const stale = await GET(request);
    expect(stale.status).toBe(503);
    expect((await stale.json()).maxAgeHours).toBe(12);

    vi.clearAllMocks();
    mockValidate.mockReturnValue(null);
    mockSend.mockResolvedValue(page([{ ...FRESH_ENC, LastModified: hoursAgo(20) }]));
    process.env.BACKUP_MAX_AGE_HOURS = '48';
    const fresh = await GET(request);
    expect(fresh.status).toBe(200);
  });

  it('follows pagination to find the true newest object', async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'db-backups/old.dump.enc', LastModified: hoursAgo(500), Size: 10 }],
        IsTruncated: true,
        NextContinuationToken: 'tok-1',
      })
      .mockResolvedValueOnce(page([FRESH_ENC]));

    const response = await GET(request);
    const body = await response.json();

    expect(mockSend).toHaveBeenCalledTimes(2);
    const second = mockSend.mock.calls[1][0] as { input: Record<string, unknown> };
    expect(second.input.ContinuationToken).toBe('tok-1');
    expect(response.status).toBe(200);
    expect(body.objectsSeen).toBe(2);
    expect(body.newestKey).toBe(FRESH_ENC.Key);
  });

  it('skips keys with no LastModified rather than aging them as "now"', async () => {
    mockSend.mockResolvedValue(
      page([
        { Key: 'db-backups/pagespace-2026-08-08.dump.enc', Size: 100 }, // no LastModified
        { Key: 'db-backups/pagespace-2026-06-25.dump.enc', LastModified: hoursAgo(1067), Size: 100 },
      ])
    );

    const response = await GET(request);
    const body = await response.json();

    expect(body.objectsSeen).toBe(1);
    expect(response.status).toBe(503);
    expect(body.reason).toBe('stale');
  });

  it('alerts (not just logs) when the listing itself fails', async () => {
    mockSend.mockRejectedValue(new Error('Tigris unreachable'));

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Internal server error');
    expect(mockLoggers.api.error).toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0][1].fingerprint).toEqual([
      'db-backup-freshness',
      'check_failed',
    ]);
    expect(mockFlush).toHaveBeenCalled();
  });

  it('does not leak the bucket error detail to the caller', async () => {
    mockSend.mockRejectedValue(new Error('AccessDenied for key AKIA-secret-looking'));

    const body = await (await GET(request)).json();

    expect(JSON.stringify(body)).not.toContain('AKIA');
  });

  it('records an audit event for both verdicts', async () => {
    mockSend.mockResolvedValue(page([FRESH_ENC]));
    await GET(request);

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.read',
        resourceType: 'cron_job',
        resourceId: 'verify_db_backup_freshness',
      })
    );

    vi.clearAllMocks();
    mockValidate.mockReturnValue(null);
    mockSend.mockResolvedValue(page([]));
    await GET(request);

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ ok: false }) })
    );
  });

  it('POST behaves identically to GET', async () => {
    mockSend.mockResolvedValue(page([FRESH_ENC]));

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  });
});
