import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { isHashBlocked } from '@pagespace/lib/content-safety/blocklist';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';

const CONTENT_TYPE_MAP: Record<string, string> = {
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

// Matches CUID2, UUID, and similar ID formats: alphanumeric + hyphens, min 3 chars
const SAFE_USER_ID = /^[a-z0-9][a-z0-9_-]{2,}$/i;
const MAX_FILENAME_LEN = 255;
const ALLOWED_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/**
 * How long a served avatar may be cached. Bounded, and not `immutable`: an avatar whose hash is blocked after it
 * was cached stops being served within the hour (a new upload changes the URL's `?t=` anyway).
 */
const AVATAR_CACHE_CONTROL = 'public, max-age=3600';

function isValidFilename(filename: string): boolean {
  if (!filename || filename.length > MAX_FILENAME_LEN) return false;
  if (filename.includes('/') || filename.includes('\\')) return false;
  if (filename.startsWith('.')) return false;
  if (filename.includes('..')) return false;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ALLOWED_EXTS.has(ext);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ userId: string; filename: string }> }
) {
  try {
    const { userId, filename } = await context.params;

    if (!SAFE_USER_ID.test(userId)) {
      return new NextResponse('Bad Request', { status: 400 });
    }

    if (!isValidFilename(filename)) {
      return new NextResponse('Bad Request', { status: 400 });
    }

    const ext = filename.split('.').pop()?.toLowerCase() ?? 'jpeg';
    const key = `avatars/${userId}/${filename}`;

    try {
      const response = await getS3Client().send(new GetObjectCommand({
        Bucket: getS3Bucket(),
        Key: key,
      }));
      if (!response.Body) return new NextResponse('Not Found', { status: 404 });
      const bytes = await response.Body.transformToByteArray();
      // Blocked bytes are never served, whenever they were stored (an upload that raced the block, a takedown not
      // yet run on this avatar). Couldn't-check serves nothing, and neither answer may be cached.
      let blocked: boolean;
      try {
        blocked = await isHashBlocked(createHash('sha256').update(bytes).digest('hex'));
      } catch (blocklistError) {
        console.warn('Avatar not served: the blocklist could not be read', { key, err: String(blocklistError) });
        return new NextResponse('Service Unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
      if (blocked) return new NextResponse('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
      const contentType = CONTENT_TYPE_MAP[ext] || 'image/jpeg';
      return new NextResponse(bytes, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': AVATAR_CACHE_CONTROL,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (err) {
      const isNotFound = err && typeof err === 'object' && ('$metadata' in err
        ? (err as { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode === 404
        : (err as { name?: string }).name === 'NoSuchKey');
      if (!isNotFound) console.warn('Avatar S3 read error', { key, err: String(err) });
      return new NextResponse('Not Found', { status: 404 });
    }
  } catch (error) {
    console.error('Error serving avatar:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
