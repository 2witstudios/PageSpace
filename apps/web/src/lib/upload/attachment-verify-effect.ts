import {
  createAttachmentUploadServiceToken,
} from '@pagespace/lib/services/attachment-upload';
import type { AttachmentTarget } from '@pagespace/lib/services/attachment-upload-core';

/**
 * Web→processor seam for synchronous attachment byte-verification. The bytes are
 * read from S3 by the processor (never through the web service); only the verdict
 * + true MIME come back. Used by completeAttachment before any DB rows are created.
 */

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';
const VERIFY_TIMEOUT_MS = 30_000;

export type AttachmentVerifyResult =
  | { ok: true; detectedMime: string; size: number }
  | { ok: false; status: number; error: string };

interface ProcessorVerifyBody {
  ok?: boolean;
  detectedMime?: string;
  size?: number;
  reason?: string;
}

/**
 * Pure mapping of the processor /api/verify HTTP response to the web /complete
 * outcome. Mirrors the processor's documented contract (see verify-core.ts):
 * 200 = definitive verdict, 413 = oversize, 503 = retryable infra, else bad gateway.
 */
export function interpretVerifyResponse(status: number, body: ProcessorVerifyBody): AttachmentVerifyResult {
  if (status === 200) {
    if (body.ok && typeof body.detectedMime === 'string' && typeof body.size === 'number') {
      return { ok: true, detectedMime: body.detectedMime, size: body.size };
    }
    // Definitive negative verdict (hash_mismatch | object_not_found) — do not retry.
    const error =
      body.reason === 'hash_mismatch'
        ? 'Uploaded file failed integrity verification'
        : 'Uploaded file was not found in storage';
    return { ok: false, status: 422, error };
  }
  if (status === 413) return { ok: false, status: 413, error: 'File too large' };
  if (status === 503) return { ok: false, status: 503, error: 'Storage temporarily unavailable. Please try again.' };
  return { ok: false, status: 502, error: 'File verification failed' };
}

/**
 * Re-hash + content-type the stored object via the processor, bound to the
 * attachment target. Returns the true MIME type to persist on success, or a
 * mapped failure the route can surface.
 */
export async function verifyAttachmentBytes(args: {
  userId: string;
  target: AttachmentTarget;
  contentHash: string;
}): Promise<AttachmentVerifyResult> {
  const { userId, target, contentHash } = args;

  const { token } = await createAttachmentUploadServiceToken({ userId, target });

  const res = await fetch(`${PROCESSOR_URL}/api/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentHash }),
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });

  const body = (await res.json().catch(() => ({}))) as ProcessorVerifyBody;
  return interpretVerifyResponse(res.status, body);
}
