import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { computeContentHash } from './content-hash';

/**
 * Direct-to-S3 upload orchestrator. Each step is a single-responsibility async
 * function; uploadFileToS3 composes them. App endpoints go through fetchWithAuth
 * (CSRF + credentials); the byte transfer goes straight to Tigris via XHR so
 * progress events are available. A reserved slot is always released on failure.
 */

export interface PresignParams {
  contentHash: string;
  driveId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}

export interface PresignResponse {
  url?: string;
  jobId: string;
  key: string;
  expiresAt?: string;
  alreadyExists?: boolean;
}

export interface CompleteParams {
  jobId: string;
  contentHash: string;
  driveId: string;
  title: string;
  mimeType: string;
  fileSize: number;
  parentId?: string | null;
  // Tree ordering: drop a file before/after a sibling node. Omitted = append.
  position?: 'before' | 'after' | null;
  afterNodeId?: string | null;
}

export interface UploadedPage {
  id: string;
  [key: string]: unknown;
}

export interface CompletionResponse {
  success: boolean;
  page: UploadedPage;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || fallback;
}

export async function callPresign(params: PresignParams): Promise<PresignResponse> {
  const res = await fetchWithAuth('/api/upload/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to presign upload'));
  return res.json() as Promise<PresignResponse>;
}

export async function callComplete(params: CompleteParams): Promise<CompletionResponse> {
  const res = await fetchWithAuth('/api/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to complete upload'));
  return res.json() as Promise<CompletionResponse>;
}

/** Best-effort slot release — never throws, so cleanup can't mask the original error. */
export async function callCancel(jobId: string): Promise<void> {
  try {
    await fetchWithAuth('/api/upload/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
  } catch {
    // swallow — the semaphore's stale-slot cleanup is the backstop
  }
}

/** PUT the file straight to Tigris via XHR so upload progress is observable. */
export function uploadToTigris(
  url: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // Must match the Content-Type the presigned URL was signed with. presign
    // derives it the same way (file.type || 'application/octet-stream'), so an
    // empty file.type would otherwise send no header and break the signature.
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (onProgress && event.total > 0) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed with status ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.send(file);
  });
}

export interface UploadTarget {
  driveId: string;
  parentId?: string | null;
  /** Override the page title; defaults to the file name. */
  title?: string;
  /** Tree ordering on drop. Omitted = append at the end of the sibling list. */
  position?: 'before' | 'after' | null;
  afterNodeId?: string | null;
}

export async function uploadFileToS3(
  file: File,
  target: UploadTarget,
  onProgress?: (pct: number) => void,
): Promise<UploadedPage> {
  const contentHash = await computeContentHash(file);
  const mimeType = file.type || 'application/octet-stream';
  // Some drop/paste sources yield a File with an empty name; presign requires a
  // non-empty filename and /complete a non-empty title, so fall back to a label.
  const filename = file.name || 'Untitled';
  const title = target.title?.trim() || filename;

  const presign = await callPresign({
    contentHash,
    driveId: target.driveId,
    filename,
    mimeType,
    fileSize: file.size,
  });

  try {
    if (!presign.alreadyExists) {
      if (!presign.url) throw new Error('Presign response missing upload URL');
      await uploadToTigris(presign.url, file, onProgress);
    }

    const completion = await callComplete({
      jobId: presign.jobId,
      contentHash,
      driveId: target.driveId,
      title,
      mimeType,
      fileSize: file.size,
      parentId: target.parentId ?? null,
      position: target.position ?? null,
      afterNodeId: target.afterNodeId ?? null,
    });
    return completion.page;
  } catch (err) {
    await callCancel(presign.jobId);
    throw err;
  }
}
