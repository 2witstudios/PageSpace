import { describe, it, expect } from 'vitest';
import {
  validateContentHash,
  validateFileSize,
  validateMimeTypeDeclaration,
  validateTtl,
  buildS3Key,
  buildPresignParams,
  canClaimExistingObject,
  canFinalizeUpload,
} from '../upload-validation';

describe('validateContentHash', () => {
  it('returns ok for a valid 64-char lowercase hex string', () => {
    const hash = 'a'.repeat(64);
    const result = validateContentHash(hash);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(hash);
  });

  it('returns ok for a valid 64-char hex string with mixed case letters', () => {
    const hash = 'aAbBcCdDeEfF'.padEnd(64, '0').slice(0, 64);
    const result = validateContentHash(hash);
    expect(result.ok).toBe(true);
  });

  it('canonicalizes a mixed-case hash to lowercase so it maps to one S3 key', () => {
    const result = validateContentHash('A'.repeat(64));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('a'.repeat(64));
  });

  it('returns err for a hash shorter than 64 chars', () => {
    const result = validateContentHash('a'.repeat(63));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/64/);
  });

  it('returns err for a hash longer than 64 chars', () => {
    const result = validateContentHash('a'.repeat(65));
    expect(result.ok).toBe(false);
  });

  it('returns err for a hash containing non-hex characters', () => {
    const result = validateContentHash('z'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/hex/i);
  });

  it('returns err for an empty string', () => {
    const result = validateContentHash('');
    expect(result.ok).toBe(false);
  });
});

describe('validateFileSize', () => {
  it('returns ok when size is within the free tier limit', () => {
    const result = validateFileSize(1024, 'free');
    expect(result.ok).toBe(true);
  });

  it('returns ok when size exactly equals the tier limit', () => {
    const limit = 50 * 1024 * 1024; // 50MB free limit
    const result = validateFileSize(limit, 'free');
    expect(result.ok).toBe(true);
  });

  it('returns err when size exceeds the free tier limit', () => {
    const overLimit = 50 * 1024 * 1024 + 1;
    const result = validateFileSize(overLimit, 'free');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/50MB/i);
      expect(result.error.message).toMatch(/free/i);
    }
  });

  it('returns err when size exceeds the pro tier limit', () => {
    const overLimit = 250 * 1024 * 1024 + 1;
    const result = validateFileSize(overLimit, 'pro');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/250MB/i);
  });

  it('returns err when size exceeds the founder tier limit', () => {
    const overLimit = 500 * 1024 * 1024 + 1;
    const result = validateFileSize(overLimit, 'founder');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/500MB/i);
  });

  it('returns ok for a large file within the business tier limit', () => {
    const result = validateFileSize(500 * 1024 * 1024, 'business');
    expect(result.ok).toBe(true);
  });

  it('returns err when size exceeds the business tier limit', () => {
    const overLimit = 1024 * 1024 * 1024 + 1;
    const result = validateFileSize(overLimit, 'business');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/1GB|1024MB/i);
  });

  it('returns err when size is zero', () => {
    const result = validateFileSize(0, 'free');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/empty/i);
  });

  it('returns err when size is negative', () => {
    const result = validateFileSize(-1, 'free');
    expect(result.ok).toBe(false);
  });
});

describe('validateMimeTypeDeclaration', () => {
  it('returns ok for a standard image type', () => {
    expect(validateMimeTypeDeclaration('image/jpeg').ok).toBe(true);
  });

  it('returns ok for a PDF', () => {
    expect(validateMimeTypeDeclaration('application/pdf').ok).toBe(true);
  });

  it('returns ok for a video type', () => {
    expect(validateMimeTypeDeclaration('video/mp4').ok).toBe(true);
  });

  it('returns err for text/html', () => {
    const result = validateMimeTypeDeclaration('text/html');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/not allowed/i);
  });

  it('returns err for image/svg+xml', () => {
    expect(validateMimeTypeDeclaration('image/svg+xml').ok).toBe(false);
  });

  it('returns err for text/javascript', () => {
    expect(validateMimeTypeDeclaration('text/javascript').ok).toBe(false);
  });

  it('returns err for application/javascript', () => {
    expect(validateMimeTypeDeclaration('application/javascript').ok).toBe(false);
  });

  it('returns err for application/x-msdownload (Windows executable)', () => {
    expect(validateMimeTypeDeclaration('application/x-msdownload').ok).toBe(false);
  });

  it('returns err for application/x-executable', () => {
    expect(validateMimeTypeDeclaration('application/x-executable').ok).toBe(false);
  });

  it('returns err for application/x-mach-binary (macOS binary)', () => {
    expect(validateMimeTypeDeclaration('application/x-mach-binary').ok).toBe(false);
  });

  it('returns err for application/x-javascript (legacy script alias)', () => {
    expect(validateMimeTypeDeclaration('application/x-javascript').ok).toBe(false);
  });

  it('ignores charset parameters when checking', () => {
    expect(validateMimeTypeDeclaration('text/html; charset=utf-8').ok).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(validateMimeTypeDeclaration('TEXT/HTML').ok).toBe(false);
  });
});

describe('validateTtl', () => {
  it('returns ok for a TTL within the 900-second limit', () => {
    expect(validateTtl(900).ok).toBe(true);
  });

  it('returns ok for a TTL of 1 second', () => {
    expect(validateTtl(1).ok).toBe(true);
  });

  it('returns err when TTL exceeds 900 seconds', () => {
    const result = validateTtl(901);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/900/);
  });

  it('returns err when TTL is zero', () => {
    expect(validateTtl(0).ok).toBe(false);
  });

  it('returns err when TTL is negative', () => {
    expect(validateTtl(-1).ok).toBe(false);
  });
});

describe('buildS3Key', () => {
  it('returns the canonical path for a given hash', () => {
    const hash = 'a'.repeat(64);
    expect(buildS3Key(hash)).toBe(`files/${hash}/original`);
  });

  it('contains no extra path segments', () => {
    const key = buildS3Key('b'.repeat(64));
    expect(key.split('/')).toHaveLength(3);
  });
});

describe('buildPresignParams', () => {
  const hash = 'a'.repeat(64);

  it('returns a plain object with all required fields', () => {
    const params = buildPresignParams(hash, 'drive-1', 'photo.jpg', 'image/jpeg', 1024, 900);
    expect(params).toMatchObject({
      key: `files/${hash}/original`,
      driveId: 'drive-1',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1024,
      ttlSeconds: 900,
    });
  });

  it('uses buildS3Key for the key field', () => {
    const params = buildPresignParams(hash, 'drive-1', 'file.pdf', 'application/pdf', 2048, 600);
    expect(params.key).toBe(buildS3Key(hash));
  });

  it('does not infer defaults from environment — all values come from arguments', () => {
    const params = buildPresignParams(hash, 'drive-2', 'video.mp4', 'video/mp4', 999, 300);
    expect(params.fileSize).toBe(999);
    expect(params.ttlSeconds).toBe(300);
  });
});

describe('canClaimExistingObject (H3 — presign dedup fast-path gate)', () => {
  const contentHash = 'a'.repeat(64);

  it('allows the dedup fast-path when the caller already references the hash', () => {
    expect(canClaimExistingObject({ contentHash, callerAlreadyReferences: true })).toBe(true);
  });

  it('denies the fast-path when the caller does not reference the hash (cross-tenant claim)', () => {
    expect(canClaimExistingObject({ contentHash, callerAlreadyReferences: false })).toBe(false);
  });

  it('decision is independent of the hash value (a known hash is never sufficient on its own)', () => {
    expect(canClaimExistingObject({ contentHash: 'f'.repeat(64), callerAlreadyReferences: false })).toBe(false);
  });
});

describe('canFinalizeUpload (H3 — /complete link gate)', () => {
  it('allows linking when the caller already references the hash (legit dedup)', () => {
    expect(canFinalizeUpload({ callerAlreadyReferences: true, existedAtPresign: true })).toBe(true);
  });

  it('allows linking when this upload created the object (did not exist at presign)', () => {
    expect(canFinalizeUpload({ callerAlreadyReferences: false, existedAtPresign: false })).toBe(true);
  });

  it('denies linking a pre-existing object the caller does not reference (the claim)', () => {
    expect(canFinalizeUpload({ callerAlreadyReferences: false, existedAtPresign: true })).toBe(false);
  });

  it('allows a referencing caller even when the object existed (re-link of own file)', () => {
    expect(canFinalizeUpload({ callerAlreadyReferences: true, existedAtPresign: false })).toBe(true);
  });
});
