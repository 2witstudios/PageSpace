import type { NextFunction, Request, Response } from 'express';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateLimitBucket>();
const DEFAULT_LIMIT = parseInt(process.env.PROCESSOR_UPLOAD_RATE_LIMIT ?? '100', 10);
const WINDOW_SECONDS = parseInt(process.env.PROCESSOR_UPLOAD_RATE_WINDOW ?? '3600', 10);

function getBucketKey(req: Request): string {
  const auth = req.serviceAuth;
  if (auth?.tenantId) {
    return `tenant:${auth.tenantId}`;
  }

  if (auth?.service) {
    return `service:${auth.service}`;
  }

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return `ip:${forwarded.split(',')[0]}`;
  }

  return `ip:${req.ip}`;
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

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}, 60_000).unref();
