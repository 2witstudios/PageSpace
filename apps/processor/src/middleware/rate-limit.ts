import type { NextFunction, Request, Response } from 'express';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateLimitBucket>();
const DEFAULT_LIMIT = parseInt(process.env.PROCESSOR_UPLOAD_RATE_LIMIT ?? '100', 10);
const WINDOW_SECONDS = parseInt(process.env.PROCESSOR_UPLOAD_RATE_WINDOW ?? '3600', 10);

function getBucketKey(req: Request): string {
  const auth = req.auth;
  // Use userId for rate limiting - this ensures rate limits accumulate per-user
  if (auth?.userId) {
    return `user:${auth.userId}`;
  }

  // Fallback to IP-based limiting for unauthenticated requests
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return `ip:${forwarded.split(',')[0]}`;
  }

  return `ip:${req.ip}`;
}

function createRateLimiter(
  bucketPrefix: string,
  limit: number,
  windowSeconds: number,
  errorMessage: string
) {
  const limitBuckets = new Map<string, RateLimitBucket>();

  // Cleanup expired buckets
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of limitBuckets.entries()) {
      if (bucket.resetAt <= now) {
        limitBuckets.delete(key);
      }
    }
  }, 60_000).unref();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (limit <= 0) {
      next();
      return;
    }

    const key = `${bucketPrefix}:${getBucketKey(req)}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const bucket = limitBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      limitBuckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (bucket.count >= limit) {
      const retryAfter = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
      res.status(429).json({
        error: errorMessage,
        retryAfter
      });
      return;
    }

    bucket.count += 1;
    next();
  };
}

export function rateLimitUpload(req: Request, res: Response, next: NextFunction): void {
  if (DEFAULT_LIMIT <= 0) {
    next();
    return;
  }

  const key = getBucketKey(req);
  const now = Date.now();
  const windowMs = WINDOW_SECONDS * 1000;
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    next();
    return;
  }

  if (bucket.count >= DEFAULT_LIMIT) {
    const retryAfter = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
    res.status(429).json({
      error: 'Upload rate limit exceeded',
      retryAfter
    });
    return;
  }

  bucket.count += 1;
  next();
}

const READ_LIMIT = parseInt(process.env.PROCESSOR_READ_RATE_LIMIT ?? '1000', 10);
const READ_WINDOW_SECONDS = parseInt(process.env.PROCESSOR_READ_RATE_WINDOW ?? '3600', 10);

export const rateLimitRead = createRateLimiter(
  'read',
  READ_LIMIT,
  READ_WINDOW_SECONDS,
  'Read rate limit exceeded'
);

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}, 60_000).unref();
