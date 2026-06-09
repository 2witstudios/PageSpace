import { STORAGE_TIERS, type SubscriptionTier } from './subscription-utils';
// Per-file size limits come from the canonical STORAGE_TIERS table in
// subscription-utils (no DB imports transitively, so this module stays pure).

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
  // Canonicalize to lowercase so the same digest always maps to one S3 key.
  return { ok: true, value: hash.toLowerCase() };
}

export function validateFileSize(size: number, tier: SubscriptionTier): ValidationResult {
  if (size <= 0) {
    return { ok: false, error: { message: 'File must not be empty' } };
  }
  const limit = STORAGE_TIERS[tier].maxFileSize;
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

/**
 * H3 — cross-tenant file-claim defense (presign fast-path gate).
 *
 * Storage is content-addressed in a GLOBAL namespace (`files/${hash}/original`),
 * so a content hash a caller scraped from a presigned URL or a `contentHash` API
 * field is enough to find that another tenant's bytes already exist in S3. The
 * old presign returned `{ alreadyExists: true }` purely on object existence,
 * letting any caller skip the PUT and then /complete a FILE page in THEIR drive
 * pointing at the foreign object — a permanent, revocation-surviving claim.
 *
 * The dedup fast-path (skip the proof-of-possession PUT) is therefore honored
 * ONLY when the same user/drive already references the hash. Everyone else is
 * routed through an actual presigned PUT so they must possess the bytes.
 */
export function canClaimExistingObject(args: {
  contentHash: string;
  callerAlreadyReferences: boolean;
}): boolean {
  return args.callerAlreadyReferences;
}

/**
 * H3 — cross-tenant file-claim defense (/complete link gate).
 *
 * Forcing the PUT at presign is not sufficient on its own: an attacker handed a
 * presigned URL can simply skip it and call /complete, where a bare
 * object-existence check would still link the pre-existing (victim's) object —
 * including through a presign→complete race where the object is created by a
 * different tenant between presign and completion.
 *
 * The authoritative, race-proof proof-of-ownership is the content-addressed
 * `files` row, claimed atomically inside the completion transaction:
 *  - `fileWasInserted` — THIS completion inserted the `files` row, so the caller
 *    is the first physical storer and demonstrably possessed the bytes; OR
 *  - `ownedByCaller` — an existing `files` row was created by this caller (e.g. a
 *    re-link of their own file after the page was deleted but before reap); OR
 *  - `callerAlreadyReferences` — a page in the caller's drive already points at
 *    the hash (legitimate dedup).
 *
 * Any other case is a caller trying to link bytes they never uploaded and is
 * rejected (the transaction rolls back). This replaces the earlier
 * `existedAtPresign` snapshot, which a presign→complete race could defeat.
 */
export function canLinkExistingFileRow(args: {
  fileWasInserted: boolean;
  ownedByCaller: boolean;
  callerAlreadyReferences: boolean;
}): boolean {
  return args.fileWasInserted || args.ownedByCaller || args.callerAlreadyReferences;
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
