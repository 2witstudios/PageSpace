import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { resolveAvatarPath, verifyPathWithinBase } from '@/lib/security/safe-path';

/**
 * Content type mapping for allowed avatar extensions
 */
const CONTENT_TYPE_MAP: Record<string, string> = {
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ userId: string; filename: string }> }
) {
  try {
    const { userId, filename } = await context.params;

    // Use the configured storage path that matches processor's storage
    const storageBasePath = process.env.FILE_STORAGE_PATH || join(process.cwd(), 'storage');

    // Safely resolve the avatar path with traversal protection
    const pathResult = resolveAvatarPath(storageBasePath, userId, filename);

    if (!pathResult.success) {
      // Return generic 400 for validation errors - don't leak details
      return new NextResponse('Bad Request', { status: 400 });
    }

    const filepath = pathResult.path;

    // Verify symlinks don't escape the avatars directory (prevents symlink attacks)
    const avatarsBaseDir = resolve(storageBasePath, 'avatars');
    if (!(await verifyPathWithinBase(filepath, avatarsBaseDir))) {
      return new NextResponse('Not Found', { status: 404 });
    }

    // Read the file atomically - avoids TOCTOU race between stat() and readFile()
    // If the file doesn't exist or isn't readable, readFile will throw
    let fileBuffer: Buffer;
    try {
      fileBuffer = await readFile(filepath);
    } catch {
      return new NextResponse('Not Found', { status: 404 });
    }

    // Determine content type based on file extension (already validated by resolveAvatarPath)
    const extension = filename.split('.').pop()?.toLowerCase() || 'jpeg';
    const contentType = CONTENT_TYPE_MAP[extension] || 'image/jpeg';

    // Return the image with appropriate headers
    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    // Log error internally but don't expose details to client
    console.error('Error serving avatar:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
