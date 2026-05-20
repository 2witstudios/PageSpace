import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { resolveAvatarPath, verifyPathWithinBase } from '@/lib/security/safe-path';

const CONTENT_TYPE_MAP: Record<string, string> = {
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

// When PROCESSOR_URL points to a remote service (Fly.io, etc.) the web app
// doesn't have direct access to the file volume. Proxy avatar reads through
// the processor's public /avatars/:userId/:filename endpoint instead.
const PROCESSOR_URL = process.env.PROCESSOR_URL;
const USE_PROCESSOR_PROXY =
  PROCESSOR_URL &&
  !PROCESSOR_URL.startsWith('http://processor:') &&
  !PROCESSOR_URL.startsWith('http://localhost:');

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ userId: string; filename: string }> }
) {
  try {
    const { userId, filename } = await context.params;

    if (USE_PROCESSOR_PROXY) {
      const upstream = `${PROCESSOR_URL}/avatars/${encodeURIComponent(userId)}/${encodeURIComponent(filename)}`;
      const res = await fetch(upstream, { next: { revalidate: 86400 } });
      if (!res.ok) {
        return new NextResponse('Not Found', { status: 404 });
      }
      const contentType = res.headers.get('Content-Type') || 'image/jpeg';
      return new NextResponse(res.body, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    // Local filesystem path (Docker Compose / self-hosted with shared volume)
    const storageBasePath = process.env.FILE_STORAGE_PATH || join(process.cwd(), 'storage');

    const pathResult = resolveAvatarPath(storageBasePath, userId, filename);
    if (!pathResult.success) {
      return new NextResponse('Bad Request', { status: 400 });
    }

    const filepath = pathResult.path;
    const avatarsBaseDir = resolve(storageBasePath, 'avatars');
    if (!(await verifyPathWithinBase(filepath, avatarsBaseDir))) {
      return new NextResponse('Not Found', { status: 404 });
    }

    let fileBuffer: Buffer;
    try {
      fileBuffer = await readFile(filepath);
    } catch {
      return new NextResponse('Not Found', { status: 404 });
    }

    const extension = filename.split('.').pop()?.toLowerCase() || 'jpeg';
    const contentType = CONTENT_TYPE_MAP[extension] || 'image/jpeg';

    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('Error serving avatar:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
