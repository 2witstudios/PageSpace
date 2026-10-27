/**
 * The steps every avatar route shares, for any subject that has one (an org: ORG-1; a drive). Each
 * route supplies its own gate, its own row switch, audit and announcement; the upload checks, the
 * storage calls and the members-only read are the same for all of them.
 *
 * Order (review of #2869): write the new file, switch the stored path to it, then delete the file
 * it replaced, so the stored path always names a file that exists, and concurrent uploads each
 * delete only the file their switch replaced (the row switch locks the row).
 */
import { NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
  avatarStorageKey,
  isAvatarFilename,
  type AvatarSubject,
} from '@pagespace/lib/avatars/avatar-core';
import { apiError } from '@/lib/api/api-error';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';
import type { AvatarStorageCall } from './avatar-storage';

const LABELS: Readonly<Record<AvatarSubject, { a: string; Label: string }>> = {
  org: { a: 'an organization', Label: 'Org' },
  drive: { a: 'a drive', Label: 'Drive' },
};

const CONTENT_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const isNotFound = (err: unknown): boolean =>
  !!err && typeof err === 'object' && ('$metadata' in err
    ? (err as { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode === 404
    : (err as { name?: string }).name === 'NoSuchKey');

/** The uploaded image from a multipart body, or the 400 that refuses it. */
export async function readAvatarUpload(request: Request): Promise<{ ok: true; file: File } | { ok: false; response: NextResponse }> {
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  // A FormData entry is a string or a File; anything else (or nothing) is not an upload.
  if (!file || typeof file === 'string') return { ok: false, response: apiError(400, 'invalid_request', 'No image provided') };
  if (!AVATAR_MIME_TYPES.includes(file.type)) {
    return { ok: false, response: apiError(400, 'invalid_request', 'Upload a JPEG, PNG, GIF or WebP image') };
  }
  if (file.size > AVATAR_MAX_BYTES) return { ok: false, response: apiError(400, 'invalid_request', 'The image is larger than 5 MB') };
  return { ok: true, file };
}

/** Stores the image as a new file through the route's own storage call, and answers its name; null when storage refused it. */
export async function storeAvatarFile(subject: AvatarSubject, id: string, storage: AvatarStorageCall, file: File): Promise<string | null> {
  const body = new FormData();
  body.append('file', file);
  const stored = await storage({ method: 'POST', body });
  const result: unknown = await stored.json().catch(() => null);
  const filename = result && typeof result === 'object' && 'filename' in result ? result.filename : null;
  // Zero trust at this boundary too: only an avatar filename is ever recorded.
  if (!stored.ok || typeof filename !== 'string' || !isAvatarFilename(filename)) {
    loggers.api.error(`${LABELS[subject].Label} avatar upload rejected by storage`, undefined, { subject, id, status: stored.status });
    return null;
  }
  return filename;
}

/**
 * Removes one stored file, best effort: by the time this runs nothing points at it, so a file left
 * behind is logged, never shown.
 */
export async function removeAvatarFile(subject: AvatarSubject, id: string, storage: AvatarStorageCall, filename: string | null): Promise<void> {
  if (!filename) return;
  const removed = await storage({ method: 'DELETE', filename }).catch((error: unknown) => error);
  if (!(removed instanceof Response) || !removed.ok) loggers.api.warn(`${LABELS[subject].Label} avatar file was not removed`, { subject, id, filename });
}

/** The avatar image itself, once the route has let the reader in (members only). */
export async function serveAvatarFile(subject: AvatarSubject, id: string, filename: string): Promise<NextResponse> {
  if (!isAvatarFilename(filename)) return apiError(400, 'invalid_request', `Not ${LABELS[subject].a} avatar`);
  const key = avatarStorageKey(subject, id, filename);
  try {
    const object = await getS3Client().send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }));
    if (!object.Body) return new NextResponse('Not Found', { status: 404 });
    const bytes = await object.Body.transformToByteArray();
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': CONTENT_TYPES[filename.split('.').pop() ?? ''] ?? 'application/octet-stream',
        // Members only, so never a shared cache; the stored path is versioned, so the browser may keep it.
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    if (!isNotFound(err)) loggers.api.warn(`${LABELS[subject].Label} avatar read error`, { key, err: String(err) });
    return new NextResponse('Not Found', { status: 404 });
  }
}
