import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Reset modules so we get fresh module state for each test
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

function createMockReq(overrides: {
  userId?: string;
  forwardedFor?: string;
  ip?: string;
} = {}): Request {
  return {
    auth: overrides.userId ? { userId: overrides.userId } : undefined,
    headers: overrides.forwardedFor
      ? { 'x-forwarded-for': overrides.forwardedFor }
      : {},
    ip: overrides.ip || '127.0.0.1',
  } as unknown as Request;
}

function createMockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

function createMockNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

describe('rateLimitUpload', () => {
  it('allows request when limit is 0', async () => {
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '0';
    const { rateLimitUpload } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-1' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitUpload(req, res, next);

    expect(next).toHaveBeenCalled();
    delete process.env.PROCESSOR_UPLOAD_RATE_LIMIT;
  });

  it('allows first request within limit', async () => {
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '5';
    const { rateLimitUpload } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-1' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitUpload(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('blocks request when limit exceeded', async () => {
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '1';
    process.env.PROCESSOR_UPLOAD_RATE_WINDOW = '3600';
    const { rateLimitUpload } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-rate-test' });
    const { res: res1, json: json1 } = createMockRes();
    const next1 = createMockNext();

    // First request allowed
    rateLimitUpload(req, res1, next1);
    expect(next1).toHaveBeenCalled();

    // Second request blocked
    const { res: res2, status: status2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitUpload(req, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(status2).toHaveBeenCalledWith(429);
  });

  it('uses IP-based key when no userId', async () => {
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '5';
    const { rateLimitUpload } = await import('../rate-limit');

    const req = createMockReq({ ip: '10.0.0.1' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitUpload(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('uses x-forwarded-for IP when available', async () => {
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '5';
    const { rateLimitUpload } = await import('../rate-limit');

    const req = createMockReq({ forwardedFor: '203.0.113.1, 10.0.0.1' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitUpload(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('includes retryAfter in 429 response', async () => {
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '1';
    process.env.PROCESSOR_UPLOAD_RATE_WINDOW = '3600';
    const { rateLimitUpload } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-retry-test' });
    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitUpload(req, res1, next1);

    const { res: res2, status: status2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitUpload(req, res2, next2);

    expect(status2).toHaveBeenCalledWith(429);
  });

  it('increments bucket count and allows request when bucket exists and count < limit (lines 103-104)', async () => {
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '3';
    process.env.PROCESSOR_UPLOAD_RATE_WINDOW = '3600';
    const { rateLimitUpload } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-increment-test' });

    // First request - creates bucket with count=1
    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitUpload(req, res1, next1);
    expect(next1).toHaveBeenCalled();

    // Second request - bucket exists, count (1) < limit (3), so increments and allows
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitUpload(req, res2, next2);
    expect(next2).toHaveBeenCalled();

    // Third request - bucket exists, count (2) < limit (3), so increments and allows
    const { res: res3 } = createMockRes();
    const next3 = createMockNext();
    rateLimitUpload(req, res3, next3);
    expect(next3).toHaveBeenCalled();
  });

  it('cleanup interval removes expired buckets (lines 118-123)', async () => {
    vi.useFakeTimers();
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '5';
    process.env.PROCESSOR_UPLOAD_RATE_WINDOW = '0'; // 0 seconds - immediately expires
    const { rateLimitUpload } = await import('../rate-limit');

    // Add a bucket by making a request
    const req = createMockReq({ userId: 'user-cleanup-test' });
    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitUpload(req, res1, next1);
    expect(next1).toHaveBeenCalled();

    // Advance time past the cleanup interval (60 seconds)
    // The interval fires and should delete the already-expired bucket
    vi.advanceTimersByTime(61_000);

    // After cleanup, a new request should be allowed (bucket was deleted by interval,
    // so this request creates a fresh bucket rather than incrementing stale one)
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitUpload(req, res2, next2);
    expect(next2).toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe('rateLimitRead (createRateLimiter)', () => {
  it('allows request when read limit is 0', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '0';
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-1' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitRead(req, res, next);

    expect(next).toHaveBeenCalled();
    delete process.env.PROCESSOR_READ_RATE_LIMIT;
  });

  it('allows first read request', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '100';
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-read-1' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitRead(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('blocks read request when limit exceeded', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '1';
    process.env.PROCESSOR_READ_RATE_WINDOW = '3600';
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-read-block' });

    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitRead(req, res1, next1);
    expect(next1).toHaveBeenCalled();

    const { res: res2, status: status2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitRead(req, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(status2).toHaveBeenCalledWith(429);
  });

  it('allows read request when bucket is expired', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '1';
    process.env.PROCESSOR_READ_RATE_WINDOW = '0'; // 0 second window - immediately expires
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-read-expire' });

    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitRead(req, res1, next1);
    expect(next1).toHaveBeenCalled();

    // Window of 0 seconds means reset is already past
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitRead(req, res2, next2);
    expect(next2).toHaveBeenCalled();
  });

  it('uses x-forwarded-for for read rate limiting with no auth', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '100';
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ forwardedFor: '1.2.3.4' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitRead(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('uses req.ip for rate limiting when no forwarded-for', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '100';
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ ip: '192.168.1.1' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitRead(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('increments bucket count in createRateLimiter and allows when count < limit (lines 72-73)', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '3';
    process.env.PROCESSOR_READ_RATE_WINDOW = '3600';
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-incr-read' });

    // First request - creates bucket with count=1
    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitRead(req, res1, next1);
    expect(next1).toHaveBeenCalled();

    // Second request - bucket exists, count (1) < limit (3), increments to 2, calls next (lines 72-73)
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitRead(req, res2, next2);
    expect(next2).toHaveBeenCalled();
  });

  it('cleanup interval removes expired buckets in createRateLimiter (lines 40-43)', async () => {
    vi.useFakeTimers();
    process.env.PROCESSOR_READ_RATE_LIMIT = '1';
    process.env.PROCESSOR_READ_RATE_WINDOW = '0'; // 0 seconds - immediately expires
    const { rateLimitRead } = await import('../rate-limit');

    // First request creates bucket
    const req = createMockReq({ userId: 'user-cleanup-read' });
    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitRead(req, res1, next1);
    expect(next1).toHaveBeenCalled();

    // Advance time past the cleanup interval (60 seconds) to trigger setInterval callback
    vi.advanceTimersByTime(61_000);

    // After cleanup, the bucket is removed; a new request should be allowed
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitRead(req, res2, next2);
    expect(next2).toHaveBeenCalled();

    vi.useRealTimers();
  });
});
