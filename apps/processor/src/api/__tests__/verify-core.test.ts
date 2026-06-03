import { describe, expect, it } from 'vitest';
import {
  MAX_VERIFY_BYTES,
  classifyObjectSize,
  verifyResponse,
} from '../verify-core';

describe('classifyObjectSize', () => {
  it('treats a null size (no object) as absent', () => {
    expect(classifyObjectSize(null)).toBe('absent');
  });

  it('treats a size above the cap as too_large', () => {
    expect(classifyObjectSize(MAX_VERIFY_BYTES + 1)).toBe('too_large');
  });

  it('treats a size exactly at the cap as ok', () => {
    expect(classifyObjectSize(MAX_VERIFY_BYTES)).toBe('ok');
  });

  it('treats a normal size as ok', () => {
    expect(classifyObjectSize(1024)).toBe('ok');
  });

  it('treats a zero-byte object as ok', () => {
    expect(classifyObjectSize(0)).toBe('ok');
  });
});

describe('verifyResponse', () => {
  it('maps a match to 200 ok:true with detected MIME and size', () => {
    expect(verifyResponse({ kind: 'match', detectedMime: 'image/png', detectedLabel: 'png', size: 42 })).toEqual({
      status: 200,
      body: { ok: true, detectedMime: 'image/png', detectedLabel: 'png', size: 42 },
    });
  });

  it('maps a hash mismatch to a definitive 200 ok:false (do-not-retry)', () => {
    expect(verifyResponse({ kind: 'mismatch' })).toEqual({
      status: 200,
      body: { ok: false, reason: 'hash_mismatch' },
    });
  });

  it('maps an absent object to a definitive 200 ok:false (do-not-retry)', () => {
    expect(verifyResponse({ kind: 'absent' })).toEqual({
      status: 200,
      body: { ok: false, reason: 'object_not_found' },
    });
  });

  it('maps an oversize object to 413 (do-not-retry)', () => {
    expect(verifyResponse({ kind: 'too_large', size: 999 })).toEqual({
      status: 413,
      body: { ok: false, reason: 'object_too_large', size: 999 },
    });
  });

  it('maps an infra failure to a retryable 503', () => {
    expect(verifyResponse({ kind: 'storage_error' })).toEqual({
      status: 503,
      body: { ok: false, reason: 'storage_error' },
    });
  });
});
