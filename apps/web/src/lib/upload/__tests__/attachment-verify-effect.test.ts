import { describe, it, expect } from 'vitest';
import { interpretVerifyResponse } from '../attachment-verify-effect';

describe('interpretVerifyResponse', () => {
  it('accepts a 200 ok:true verdict and surfaces the detected MIME + size', () => {
    const result = interpretVerifyResponse(200, { ok: true, detectedMime: 'application/pdf', size: 2048 });
    expect(result).toEqual({ ok: true, detectedMime: 'application/pdf', size: 2048 });
  });

  it('rejects a 200 hash_mismatch verdict as a definitive 422', () => {
    const result = interpretVerifyResponse(200, { ok: false, reason: 'hash_mismatch' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
  });

  it('rejects a 200 object_not_found verdict as a definitive 422', () => {
    const result = interpretVerifyResponse(200, { ok: false, reason: 'object_not_found' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
  });

  it('treats a 200 ok:true with a missing detectedMime as a failure (defensive)', () => {
    const result = interpretVerifyResponse(200, { ok: true, size: 10 });
    expect(result.ok).toBe(false);
  });

  it('maps 413 to a do-not-retry too-large failure', () => {
    const result = interpretVerifyResponse(413, { ok: false, reason: 'object_too_large' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });

  it('maps 503 to a retryable storage failure', () => {
    const result = interpretVerifyResponse(503, { ok: false, reason: 'storage_error' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it('maps any other status to a 502 verification failure', () => {
    const result = interpretVerifyResponse(500, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });
});
