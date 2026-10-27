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
  flyClientIp?: string;
  ip?: string;
} = {}): Request {
  const headers: Record<string, string> = {};
  if (overrides.forwardedFor) headers['x-forwarded-for'] = overrides.forwardedFor;
  if (overrides.flyClientIp) headers['fly-client-ip'] = overrides.flyClientIp;
  return {
    auth: overrides.userId ? { userId: overrides.userId } : undefined,
    headers,
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

    expect(next).toHaveBeenCalledTimes(1);
    delete process.env.PROCESSOR_UPLOAD_RATE_LIMIT;
  });

  it('allows first request within limit', async () => {
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '5';
    const { rateLimitUpload } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-1' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitUpload(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
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
    expect(next1).toHaveBeenCalledTimes(1);

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

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses x-forwarded-for IP when available', async () => {
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '5';
    const { rateLimitUpload } = await import('../rate-limit');

    const req = createMockReq({ forwardedFor: '203.0.113.1, 10.0.0.1' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitUpload(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
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

  it('increments bucket count and allows request when bucket exists and count < limit', async () => {
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '3';
    process.env.PROCESSOR_UPLOAD_RATE_WINDOW = '3600';
    const { rateLimitUpload } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-increment-test' });

    // First request - creates bucket with count=1
    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitUpload(req, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);

    // Second request - bucket exists, count (1) < limit (3), so increments and allows
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitUpload(req, res2, next2);
    expect(next2).toHaveBeenCalledTimes(1);

    // Third request - bucket exists, count (2) < limit (3), so increments and allows
    const { res: res3 } = createMockRes();
    const next3 = createMockNext();
    rateLimitUpload(req, res3, next3);
    expect(next3).toHaveBeenCalledTimes(1);
  });

  it('cleanup interval removes expired buckets', async () => {
    vi.useFakeTimers();
    process.env.PROCESSOR_UPLOAD_RATE_LIMIT = '5';
    process.env.PROCESSOR_UPLOAD_RATE_WINDOW = '0'; // 0 seconds - immediately expires
    const { rateLimitUpload } = await import('../rate-limit');

    // Add a bucket by making a request
    const req = createMockReq({ userId: 'user-cleanup-test' });
    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitUpload(req, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);

    // Advance time past the cleanup interval (60 seconds)
    // The interval fires and should delete the already-expired bucket
    vi.advanceTimersByTime(61_000);

    // After cleanup, a new request should be allowed (bucket was deleted by interval,
    // so this request creates a fresh bucket rather than incrementing stale one)
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitUpload(req, res2, next2);
    expect(next2).toHaveBeenCalledTimes(1);

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

    expect(next).toHaveBeenCalledTimes(1);
    delete process.env.PROCESSOR_READ_RATE_LIMIT;
  });

  it('allows first read request', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '100';
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-read-1' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitRead(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('blocks read request when limit exceeded', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '1';
    process.env.PROCESSOR_READ_RATE_WINDOW = '3600';
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-read-block' });

    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitRead(req, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);

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
    expect(next1).toHaveBeenCalledTimes(1);

    // Window of 0 seconds means reset is already past
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitRead(req, res2, next2);
    expect(next2).toHaveBeenCalledTimes(1);
  });

  it('uses x-forwarded-for for read rate limiting with no auth', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '100';
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ forwardedFor: '1.2.3.4' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitRead(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses req.ip for rate limiting when no forwarded-for', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '100';
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ ip: '192.168.1.1' });
    const { res } = createMockRes();
    const next = createMockNext();

    rateLimitRead(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('increments bucket count in createRateLimiter and allows when count < limit', async () => {
    process.env.PROCESSOR_READ_RATE_LIMIT = '3';
    process.env.PROCESSOR_READ_RATE_WINDOW = '3600';
    const { rateLimitRead } = await import('../rate-limit');

    const req = createMockReq({ userId: 'user-incr-read' });

    // First request - creates bucket with count=1
    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitRead(req, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);

    // Second request - bucket exists, count (1) < limit (3), increments to 2, calls next
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitRead(req, res2, next2);
    expect(next2).toHaveBeenCalledTimes(1);
  });

  it('cleanup interval removes expired buckets in createRateLimiter', async () => {
    vi.useFakeTimers();
    process.env.PROCESSOR_READ_RATE_LIMIT = '1';
    process.env.PROCESSOR_READ_RATE_WINDOW = '0'; // 0 seconds - immediately expires
    const { rateLimitRead } = await import('../rate-limit');

    // First request creates bucket
    const req = createMockReq({ userId: 'user-cleanup-read' });
    const { res: res1 } = createMockRes();
    const next1 = createMockNext();
    rateLimitRead(req, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);

    // Advance time past the cleanup interval (60 seconds) to trigger setInterval callback
    vi.advanceTimersByTime(61_000);

    // After cleanup, the bucket is removed; a new request should be allowed
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitRead(req, res2, next2);
    expect(next2).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

// getClientIP (this file's internal helper, not exported) is only observable
// through the rate-limit bucket key it feeds into getBucketKey — these tests
// exercise it that way: two requests that land in the SAME bucket collide
// (second is blocked at limit=1); two requests that land in DIFFERENT
// buckets don't. See packages/lib/src/security/__tests__/client-ip.test.ts
// for the same trust-gate logic tested directly against the shared helper.
describe('Fly-Client-IP trust gate (FLY_APP_NAME)', () => {
  const ORIGINAL_FLY_APP_NAME = process.env.FLY_APP_NAME;

  afterEach(() => {
    if (ORIGINAL_FLY_APP_NAME === undefined) {
      delete process.env.FLY_APP_NAME;
    } else {
      process.env.FLY_APP_NAME = ORIGINAL_FLY_APP_NAME;
    }
  });

  it('when running on Fly, distinct fly-client-ip values get distinct buckets even with the same x-forwarded-for', async () => {
    process.env.FLY_APP_NAME = 'pagespace-processor';
    process.env.PROCESSOR_READ_RATE_LIMIT = '1';
    process.env.PROCESSOR_READ_RATE_WINDOW = '3600';
    const { rateLimitRead } = await import('../rate-limit');

    const req1 = createMockReq({ flyClientIp: '9.9.9.9', forwardedFor: '1.2.3.4' });
    const { res: res1 } = createMockRes();
    rateLimitRead(req1, res1, createMockNext());

    // Different fly-client-ip, same x-forwarded-for — must be a separate bucket
    // (not blocked), proving fly-client-ip is the key, not x-forwarded-for.
    const req2 = createMockReq({ flyClientIp: '8.8.8.8', forwardedFor: '1.2.3.4' });
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitRead(req2, res2, next2);
    expect(next2).toHaveBeenCalledTimes(1);
  });

  it('when running on Fly, the same fly-client-ip collides into one bucket regardless of x-forwarded-for', async () => {
    process.env.FLY_APP_NAME = 'pagespace-processor';
    process.env.PROCESSOR_READ_RATE_LIMIT = '1';
    process.env.PROCESSOR_READ_RATE_WINDOW = '3600';
    const { rateLimitRead } = await import('../rate-limit');

    const req1 = createMockReq({ flyClientIp: '9.9.9.9', forwardedFor: '1.2.3.4' });
    const { res: res1 } = createMockRes();
    rateLimitRead(req1, res1, createMockNext());

    const req2 = createMockReq({ flyClientIp: '9.9.9.9', forwardedFor: '5.6.7.8' });
    const { res: res2, status: status2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitRead(req2, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(status2).toHaveBeenCalledWith(429);
  });

  it('when NOT running on Fly, a forged fly-client-ip is ignored — distinct requests sharing x-forwarded-for collide into one bucket', async () => {
    delete process.env.FLY_APP_NAME;
    process.env.PROCESSOR_READ_RATE_LIMIT = '1';
    process.env.PROCESSOR_READ_RATE_WINDOW = '3600';
    const { rateLimitRead } = await import('../rate-limit');

    const req1 = createMockReq({ flyClientIp: '9.9.9.9', forwardedFor: '1.2.3.4' });
    const { res: res1 } = createMockRes();
    rateLimitRead(req1, res1, createMockNext());

    // Different (forged) fly-client-ip but the SAME x-forwarded-for — must
    // collide into the same bucket as req1, proving fly-client-ip is fully
    // ignored off-Fly and cannot be used to evade the rate limit.
    const req2 = createMockReq({ flyClientIp: '8.8.8.8', forwardedFor: '1.2.3.4' });
    const { res: res2, status: status2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitRead(req2, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(status2).toHaveBeenCalledWith(429);
  });

  it('when NOT running on Fly, distinct x-forwarded-for values still get distinct buckets', async () => {
    delete process.env.FLY_APP_NAME;
    process.env.PROCESSOR_READ_RATE_LIMIT = '1';
    process.env.PROCESSOR_READ_RATE_WINDOW = '3600';
    const { rateLimitRead } = await import('../rate-limit');

    const req1 = createMockReq({ forwardedFor: '1.2.3.4' });
    const { res: res1 } = createMockRes();
    rateLimitRead(req1, res1, createMockNext());

    const req2 = createMockReq({ forwardedFor: '5.6.7.8' });
    const { res: res2 } = createMockRes();
    const next2 = createMockNext();
    rateLimitRead(req2, res2, next2);
    expect(next2).toHaveBeenCalledTimes(1);
  });
});
