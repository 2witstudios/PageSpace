import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { computeContentHash } from './content-hash';
import { uploadToTigris } from './orchestrator';

/**
 * Client-side per-file orchestration for direct-to-S3 attachment uploads:
 * compute hash → presign → (skip PUT if dedup) PUT to Tigris → complete; any
 * failure after presign releases the reserved slot via cancel. Returns a
 * normalized result the hook maps to UI state — never throws.
 */

export interface UploadedAttachment {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  contentHash: string;
}

export type UploadAttachmentResult =
  | { ok: true; attachment: UploadedAttachment }
  | { ok: false; errorMessage: string };

/** Pure: map an upload endpoint's HTTP status (+ server error) to a toast string. */
export function attachmentUploadErrorMessage(status: number, error?: string): string {
  if (status === 413) return error || 'File too large';
  if (status === 429) return 'Too many uploads in progress. Please wait.';
  if (status === 403) return error || 'You do not have permission to upload files here.';
  return error || 'Upload failed';
}

interface PresignBody {
  url?: string;
  jobId: string;
  key: string;
  alreadyExists?: boolean;
}

async function cancel(baseUrl: string, jobId: string): Promise<void> {
  try {
    await fetchWithAuth(`${baseUrl}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
  } catch {
    // Best-effort — the semaphore's stale-slot sweep is the backstop.
  }
}

export async function uploadAttachment(baseUrl: string, file: File): Promise<UploadAttachmentResult> {
  const mimeType = file.type || 'application/octet-stream';
  const filename = file.name || 'Untitled';
  const fileSize = file.size;

  // Hash the bytes before any slot is reserved. A WebCrypto failure here must NOT
  // throw out of this function — the hook uploads files in a loop with no per-file
  // catch, so a throw would abort the whole batch. Return a result instead.
  let contentHash: string;
  try {
    contentHash = await computeContentHash(file);
  } catch {
    return { ok: false, errorMessage: 'Could not read the file for upload.' };
  }

  let presignRes: Response;
  try {
    presignRes = await fetchWithAuth(`${baseUrl}/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentHash, filename, mimeType, fileSize }),
    });
  } catch {
    return { ok: false, errorMessage: 'Upload failed. Please check your connection and try again.' };
  }
  if (!presignRes.ok) {
    const body = (await presignRes.json().catch(() => ({}))) as { error?: string };
    return { ok: false, errorMessage: attachmentUploadErrorMessage(presignRes.status, body.error) };
  }
  const presign = (await presignRes.json().catch(() => null)) as PresignBody | null;
  if (!presign || typeof presign.jobId !== 'string') {
    return { ok: false, errorMessage: 'Upload failed' };
  }
  const { jobId } = presign;

  // A slot is now reserved server-side; every failure below must cancel it.
  try {
    if (!presign.alreadyExists) {
      if (!presign.url) throw new Error('Presign response missing upload URL');
      await uploadToTigris(presign.url, file);
    }

    const completeRes = await fetchWithAuth(`${baseUrl}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, filename }),
    });
    if (!completeRes.ok) {
      const body = (await completeRes.json().catch(() => ({}))) as { error?: string };
      await cancel(baseUrl, jobId);
      return { ok: false, errorMessage: attachmentUploadErrorMessage(completeRes.status, body.error) };
    }

    const completed = (await completeRes.json().catch(() => null)) as { file?: UploadedAttachment } | null;
    if (!completed?.file) {
      await cancel(baseUrl, jobId);
      return { ok: false, errorMessage: 'Upload failed' };
    }
    return { ok: true, attachment: completed.file };
  } catch (err) {
    await cancel(baseUrl, jobId);
    // Surface the real cause (e.g. uploadToTigris's "Upload failed with status 403"
    // on an expired presigned URL) instead of a blanket message.
    return { ok: false, errorMessage: err instanceof Error && err.message ? err.message : 'Upload failed' };
  }
}
