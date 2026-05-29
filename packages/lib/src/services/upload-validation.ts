import type { SubscriptionTier } from './subscription-utils';

// Max file sizes per tier — mirrors STORAGE_TIERS in storage-limits.ts
// Kept here so this module stays pure (no DB imports transitively)
const TIER_MAX_FILE_SIZE: Record<SubscriptionTier, number> = {
  free:     50  * 1024 * 1024,
  pro:      250 * 1024 * 1024,
  founder:  500 * 1024 * 1024,
  business: 1024 * 1024 * 1024,
};

export interface ValidationError {
  message: string;
}

export type ValidationResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: ValidationError };

export interface PresignParams {
  key: string;
  driveId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  ttlSeconds: number;
}

const HEX_RE = /^[0-9a-fA-F]{64}$/;

const BLOCKED_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/vbscript',
  'application/x-executable',
  'application/x-msdownload',
  'application/x-mach-binary',
  'application/vnd.microsoft.portable-executable',
  'application/x-dosexec',
]);

export function validateContentHash(hash: string): ValidationResult<string> {
  if (!HEX_RE.test(hash)) {
    const msg = hash.length !== 64
      ? `Content hash must be exactly 64 hex characters (got ${hash.length})`
      : 'Content hash must contain only hex characters (0-9, a-f)';
    return { ok: false, error: { message: msg } };
  }
  return { ok: true, value: hash };
}

export function validateFileSize(size: number, tier: SubscriptionTier): ValidationResult {
  if (size <= 0) {
    return { ok: false, error: { message: 'File must not be empty' } };
  }
  const limit = TIER_MAX_FILE_SIZE[tier];
  if (size > limit) {
    const limitMB = limit / (1024 * 1024);
    const label = limitMB >= 1024 ? `${limitMB / 1024}GB` : `${limitMB}MB`;
    return {
      ok: false,
      error: { message: `File exceeds ${tier} tier limit of ${label}` },
    };
  }
  return { ok: true, value: undefined };
}

export function validateMimeTypeDeclaration(mimeType: string): ValidationResult {
  const normalized = mimeType.toLowerCase().split(';')[0].trim();
  if (BLOCKED_MIME_TYPES.has(normalized)) {
    return { ok: false, error: { message: `MIME type "${normalized}" is not allowed` } };
  }
  return { ok: true, value: undefined };
}

const MAX_PRESIGN_TTL_SECONDS = 900;

export function validateTtl(ttlSeconds: number): ValidationResult {
  if (ttlSeconds <= 0 || ttlSeconds > MAX_PRESIGN_TTL_SECONDS) {
    return {
      ok: false,
      error: { message: `TTL must be between 1 and ${MAX_PRESIGN_TTL_SECONDS} seconds` },
    };
  }
  return { ok: true, value: undefined };
}

export function buildS3Key(hash: string): string {
  return `files/${hash}/original`;
}

export function buildPresignParams(
  hash: string,
  driveId: string,
  filename: string,
  mimeType: string,
  fileSize: number,
  ttlSeconds: number,
): PresignParams {
  return {
    key: buildS3Key(hash),
    driveId,
    filename,
    mimeType,
    fileSize,
    ttlSeconds,
  };
}
